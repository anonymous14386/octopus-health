const express = require('express');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { BUILD, STARTED_AT, asset } = require('./build');
const { Op } = require('sequelize');
const { AuthClient } = require('@octopus-security/auth-client');
const axios = require('axios');
const app = express();

// Express 4 does NOT catch a rejected promise from an async route handler, and
// since Node 15 an unhandled rejection TERMINATES THE PROCESS. So one query
// that rejects does not fail one request — it kills the service, dropping every
// other request in flight with it. Docker restarts the container, which is why
// it reads as a random blip rather than as an error.
//
// Measured on express 4.21.2 under this Node: without the wrapper the process
// is dead and the port unreachable; with it, the request gets a 500 and the
// service carries on.
//
// 55 of the 58 async routes here have no try/catch of their own, so any query
// that rejects — a locked database, a bad id, a column that does not exist —
// takes the whole tracker down.
//
// Wrapping the routing methods once catches every handler, present and future,
// and forwards the rejection to the error handler at the bottom of this file.
for (const method of ['get', 'post', 'put', 'patch', 'delete', 'use']) {
    const original = app[method].bind(app);
    app[method] = (...args) => original(...args.map(a =>
        typeof a === 'function' && a.length < 4
            ? function (req, res, next) { return Promise.resolve(a(req, res, next)).catch(next); }
            : a));
}

// Trust proxy for correct IP detection behind Cloudflare/NGINX
app.set('trust proxy', 1);
const port = process.env.PORT || 3000;
const getDatabase = require('./database');

const auth = new AuthClient();
const AUTH_URL = process.env.AUTH_SERVICE_URL || 'http://octopus-auth:3002';

function getActiveTab(requestPath) {
    if (requestPath === '/') return 'dashboard';
    if (requestPath.startsWith('/tools') || requestPath.startsWith('/timers')) return 'tools';
    // Before the /exercise* line below, which would otherwise swallow it —
    // startsWith('/plan-maker') never got a chance because the same branch
    // returned 'exercises' for it, so BOTH nav links lit up and only cleared
    // when you clicked something else entirely.
    if (requestPath.startsWith('/plan-maker')) return 'plan-maker';
    if (requestPath.startsWith('/exercises') || requestPath.startsWith('/library') || requestPath.startsWith('/exercise') || requestPath.startsWith('/workout')) return 'exercises';
    if (requestPath.startsWith('/stretch') || requestPath.startsWith('/routines')) return 'stretch';
    // '/meal-templates' is listed on its own because it does NOT start with
    // '/meals' — the hyphen is not an 's'. Relying on a shared prefix here is the
    // same mistake that lit up two nav links for /plan-maker.
    if (requestPath.startsWith('/nutrition') || requestPath.startsWith('/meals') || requestPath.startsWith('/meal-templates')) return 'nutrition';
    if (requestPath.startsWith('/weight')) return 'weight';
    if (requestPath.startsWith('/plans')) return 'plans';
    if (requestPath.startsWith('/goals') || requestPath.startsWith('/planner') || requestPath.startsWith('/accountability')) return 'goals';
    if (requestPath.startsWith('/competitions')) return 'competitions';
    if (requestPath.startsWith('/stats')) return 'stats';
    return '';
}

// ── Periodisation phase helper ────────────────────────────────────────────────
function getPeriodisationPhase(competitionDate) {
    const today = new Date();
    const compDate = new Date(competitionDate);
    const weeksOut = Math.ceil((compDate - today) / (7 * 24 * 60 * 60 * 1000));
    if (weeksOut < 0)  return { phase: 'Past',   color: '#555',     weeksOut };
    if (weeksOut <= 1) return { phase: 'Taper',  color: '#9b59b6',  weeksOut };
    if (weeksOut <= 4) return { phase: 'Peak',   color: '#e74c3c',  weeksOut };
    if (weeksOut <= 8) return { phase: 'Build',  color: '#e67e22',  weeksOut };
    return                    { phase: 'Base',   color: '#2ecc71',  weeksOut };
}


// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// ── Liveness and deploy verification ─────────────────────────────────────────
//
// Both sit above every auth gate on purpose: "is this up" and "is the running
// container the code I pushed" have to be answerable when a login is exactly
// what is broken. There was no liveness route here at all — /api/health is a
// different thing entirely, a router about the user's health data.
// `unknown` is never `current`.
app.get('/health', (_req, res) => res.json({ ok: true, service: 'octopus-health' }));
app.get('/api/build', (_req, res) => res.json({
    ok: true,
    service: 'octopus-health',
    build: BUILD,
    startedAt: STARTED_AT,
}));

// Static files
app.use(express.static(path.join(__dirname, 'public')));

// View engine setup
app.set('view engine', 'ejs');
app.set('views', './views');

// Every render gets asset() without being passed it. Cloudflare caches CSS and
// JS for four hours and overrides the origin, so an unversioned URL means a
// shipped fix is invisible for that long and looks exactly like a failed
// deploy. app.locals rather than a per-render local because the failure mode of
// "remember to pass it" is one template quietly going stale — which is the bug,
// not a smaller version of it.
app.locals.asset = asset;

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));
// ── Stateless SSO auth ────────────────────────────────────────────────────────
// One central login at auth.octopustechnology.net sets a JWT cookie scoped to the
// whole domain. Each request we verify that cookie against octopus-auth (cached)
// and expose the user as req.user — no local session.
const SSO_COOKIE     = 'octopus_sso';
const AUTH_LOGIN_URL = (process.env.AUTH_PUBLIC_URL || 'https://auth.octopustechnology.net') + '/login';
const _verifyCache = new Map();   // token -> { user, exp }
const _seededUsers = new Set();   // usernames whose DB has been ensured this run

function parseCookies(req) {
    const out = {};
    const header = req.headers.cookie;
    if (!header) return out;
    for (const part of header.split(';')) {
        const i = part.indexOf('=');
        if (i > -1) out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim());
    }
    return out;
}

async function verifyToken(token) {
    const cached = _verifyCache.get(token);
    if (cached && cached.exp > Date.now()) return cached.user;
    try {
        const r = await axios.post(`${AUTH_URL}/api/auth/verify`, {}, {
            headers: { Authorization: `Bearer ${token}` }, timeout: 5000,
        });
        if (r.data && r.data.valid && r.data.user) {
            _verifyCache.set(token, { user: r.data.user, exp: Date.now() + 5 * 60 * 1000 });
            return r.data.user;
        }
    } catch { /* invalid or auth unreachable → treat as unauthenticated */ }
    return null;
}

// Lazily create + seed a user's DB the first time we see them this run.
async function ensureUserDb(username) {
    if (_seededUsers.has(username)) return;
    const { sequelize, seedData, migrate } = getDatabase(username);
    await sequelize.sync();
    await migrate();
    await seedData();
    _seededUsers.add(username);
}

app.use(async (req, res, next) => {
    const token = parseCookies(req)[SSO_COOKIE];
    if (token) {
        const user = await verifyToken(token);
        if (user) req.user = { username: user.username, role: user.role, token };
    }
    res.locals.user = req.user || null;
    res.locals.activeTab = getActiveTab(req.path);
    next();
});

// Mount API routes (before session-based routes)
const apiRouter = require('./api');
app.use('/api', apiRouter);

// Auth middleware — require a verified SSO user, else bounce to central login.
const requireLogin = async (req, res, next) => {
    if (!req.user) {
        const back = encodeURIComponent(`https://${req.get('host')}${req.originalUrl}`);
        return res.redirect(`${AUTH_LOGIN_URL}?redirect=${back}`);
    }
    try { await ensureUserDb(req.user.username); }
    catch (e) { console.error('ensureUserDb failed:', e.message); }
    next();
};

// Routes

// Login/register/logout are centralized at auth.octopustechnology.net now.
app.get('/login', (req, res) => {
    const back = encodeURIComponent(`https://${req.get('host')}/`);
    res.redirect(`${AUTH_LOGIN_URL}?redirect=${back}`);
});

app.get('/register', (req, res) => {
    const back = encodeURIComponent(`https://${req.get('host')}/`);
    res.redirect(`${AUTH_LOGIN_URL}?register=1&redirect=${back}`);
});

app.get('/logout', (req, res) => {
    const base = process.env.AUTH_PUBLIC_URL || 'https://auth.octopustechnology.net';
    const back = encodeURIComponent(`https://${req.get('host')}/`);
    res.redirect(`${base}/logout?redirect=${back}`);
});

// REST API endpoints for mobile app
app.post('/api/auth/register', async (req, res) => {
    try {
        const r = await auth.register(req.body.username, req.body.password, req.body.email, req.body.inviteCode);
        res.status(r.status).json(r.data);
    } catch (error) {
        res.status(503).json({ success: false, error: 'Auth service unavailable' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    try {
        const r = await auth.login(req.body.username, req.body.password);
        res.status(r.status).json(r.data);
    } catch (error) {
        res.status(503).json({ success: false, error: 'Auth service unavailable' });
    }
});

// Dashboard
app.get('/', requireLogin, async (req, res) => {
    const { WeightEntry, Exercise, Meal, Goal, Competition, TrainingSession, WorkoutSession, WorkoutSet, sequelize } = getDatabase(req.user.username);
    await sequelize.sync();

    try {
        const todayStr = new Date().toISOString().split('T')[0];

        const recentWeight = await WeightEntry.findOne({ order: [['date', 'DESC']] });
        const todayExercises = await Exercise.findAll({ where: { date: todayStr } });
        const todayMeals = await Meal.findAll({ where: { date: todayStr } });
        const activeGoals = await Goal.findAll({ where: { completed: false } });

        const todayCalories = todayMeals.reduce((sum, meal) => sum + (meal.calories || 0), 0);
        const todayExerciseMinutes = todayExercises.reduce((sum, ex) => sum + ex.duration, 0);

        // Fetch today's WorkoutSessions with their sets for the dashboard detail view
        const rawSessions = await WorkoutSession.findAll({
            where: { date: todayStr, status: 'finished' },
            order: [['startedAt', 'ASC']],
        });
        const todayWorkoutSessions = await Promise.all(rawSessions.map(async s => {
            const sets = await WorkoutSet.findAll({
                where: { sessionId: s.id },
                order: [['exerciseOrder', 'ASC'], ['setNumber', 'ASC']],
            });
            const byExercise = {};
            for (const set of sets) {
                if (!byExercise[set.exerciseOrder]) byExercise[set.exerciseOrder] = { name: set.exerciseName, sets: [] };
                byExercise[set.exerciseOrder].sets.push(set);
            }
            return { ...s.toJSON(), exercises: Object.values(byExercise) };
        }));

        // Upcoming competition widget
        const nextComp = await Competition.findOne({
            where: { isActive: true, date: { [Op.gte]: todayStr } },
            order: [['date', 'ASC']],
        });
        let competitionWidget = null;
        if (nextComp) {
            const phase = getPeriodisationPhase(nextComp.date);
            let regWarning = null;
            if (nextComp.registrationDeadline) {
                const regDays = Math.ceil((new Date(nextComp.registrationDeadline) - new Date()) / (24 * 60 * 60 * 1000));
                if (regDays > 0 && regDays <= 14) regWarning = regDays;
            }
            competitionWidget = { ...nextComp.toJSON(), phase, regWarning };
        }

        // Today's planned sessions
        const todaySessions = await TrainingSession.findAll({ where: { date: todayStr } });

        res.render('index', {
            title: 'Health Tracker Dashboard',
            user: req.user,
            recentWeight,
            todayExercises,
            todayMeals,
            activeGoals,
            todayCalories,
            todayExerciseMinutes,
            competitionWidget,
            todaySessions,
            todayWorkoutSessions,
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Error loading dashboard');
    }
});

app.get('/tools', requireLogin, (req, res) => {
    res.render('tools', { title: 'Tools', user: req.user });
});

// Weight tracking routes
app.get('/weight', requireLogin, async (req, res) => {
    const { WeightEntry } = getDatabase(req.user.username);
    const entries = await WeightEntry.findAll({
        order: [['date', 'DESC']],
    });
    res.render('weight', { title: 'Weight Tracking', entries, user: req.user });
});

app.post('/weight', requireLogin, async (req, res) => {
    const { WeightEntry } = getDatabase(req.user.username);
    await WeightEntry.create(req.body);
    res.redirect('/weight');
});

app.post('/weight/edit/:id', requireLogin, async (req, res) => {
    const { WeightEntry } = getDatabase(req.user.username);
    const { date, weight, unit, notes } = req.body;
    await WeightEntry.update(
        { date, weight, unit, notes },
        { where: { id: req.params.id } }
    );
    res.redirect('/weight');
});

app.post('/weight/delete/:id', requireLogin, async (req, res) => {
    const { WeightEntry } = getDatabase(req.user.username);
    await WeightEntry.destroy({ where: { id: req.params.id } });
    res.redirect('/weight');
});

// Exercise tracking routes
app.get('/exercise', requireLogin, async (req, res) => {
    const { Exercise } = getDatabase(req.user.username);
    const exercises = await Exercise.findAll({ 
        order: [['date', 'DESC']], 
        limit: 30 
    });
    res.render('exercise', { title: 'Exercise Tracking', exercises, user: req.user });
});

app.post('/exercise', requireLogin, async (req, res) => {
    const { Exercise } = getDatabase(req.user.username);
    await Exercise.create(req.body);
    res.redirect('/exercise');
});

app.get('/nutrition', requireLogin, async (req, res) => {
    const { Meal } = getDatabase(req.user.username);
    const meals = await Meal.findAll({
        order: [['date', 'DESC'], ['time', 'DESC']],
        limit: 30
    });
    res.render('meals', { title: 'Nutrition', meals, user: req.user });
});

app.post('/exercise/delete/:id', requireLogin, async (req, res) => {
    const { Exercise } = getDatabase(req.user.username);
    await Exercise.destroy({ where: { id: req.params.id } });
    res.redirect('/exercise');
});

// Meal/Food tracking routes
app.get('/meals', requireLogin, async (req, res) => {
    const { Meal } = getDatabase(req.user.username);
    const meals = await Meal.findAll({ 
        order: [['date', 'DESC'], ['time', 'DESC']], 
        limit: 30 
    });
    res.render('meals', { title: 'Food Tracking', meals, user: req.user });
});

app.post('/meals', requireLogin, async (req, res) => {
    const { Meal } = getDatabase(req.user.username);
    await Meal.create(req.body);
    res.redirect('/meals');
});

app.post('/meals/delete/:id', requireLogin, async (req, res) => {
    const { Meal } = getDatabase(req.user.username);
    await Meal.destroy({ where: { id: req.params.id } });
    res.redirect('/meals');
});

// ── Saved meals (templates) ───────────────────────────────────────────────────
//
// getDatabase(req.user.username) opens THAT person's file, so every query below is
// scoped by construction — pattern B in octopus-ops/MULTI-USER.md. The `where: {
// id }` clauses carry no owner column on purpose: there is no row in this file that
// belongs to anyone else. A missing template is a 404, never a 403, since a 403
// would confirm that somebody else's template exists.

const { macrosForTemplate, describe, provenance, slotsFromForm } = require('./api/meal-template');
const { snapshotFor, clampPortions, isFinished, mealFor } = require('./api/meal-prep');

const parseSlots = t => { try { return JSON.parse(t.ingredients || '[]'); } catch { return []; } };

app.get('/meal-templates', requireLogin, async (req, res) => {
    const { MealTemplate, MealPrep } = getDatabase(req.user.username);
    const rows = await MealTemplate.findAll({ where: { archived: false }, order: [['name', 'ASC']] });
    const templates = rows.map(t => ({
        id: t.id, name: t.name, mealType: t.mealType, notes: t.notes,
        slots: parseSlots(t),
    }));
    // Finished batches stay in the table but drop off the page: "0 left" is a
    // row that can only be cleared by hand, and a list that accumulates them
    // stops being glanceable, which is the only thing it is for.
    const preps = (await MealPrep.findAll({
        where: { portionsLeft: { [Op.gt]: 0 } },
        order: [['preppedOn', 'DESC'], ['name', 'ASC']],
    })).map(p => ({
        id: p.id, name: p.name, portions: p.portions, portionsLeft: p.portionsLeft,
        preppedOn: p.preppedOn, mealType: p.mealType,
        kcal: p.kcal, protein: p.protein, carbs: p.carbs, fats: p.fats,
    }));
    res.render('meal-templates', {
        title: 'Saved Meals', templates, preps, user: req.user,
        flash: req.query.logged ? `Logged: ${req.query.logged}` : null,
        warn: req.query.missed || null,
    });
});

app.post('/meal-templates', requireLogin, async (req, res) => {
    const { MealTemplate } = getDatabase(req.user.username);
    const name = String(req.body.name || '').trim();
    if (!name) return res.redirect('/meal-templates');
    await MealTemplate.create({
        name,
        mealType: ['breakfast', 'lunch', 'dinner', 'snack'].includes(req.body.mealType) ? req.body.mealType : 'snack',
        ingredients: JSON.stringify(slotsFromForm(req.body)),
        notes: req.body.notes || null,
    });
    res.redirect('/meal-templates');
});

app.post('/meal-templates/:id', requireLogin, async (req, res) => {
    const { MealTemplate } = getDatabase(req.user.username);
    const t = await MealTemplate.findByPk(req.params.id);
    if (!t) return res.status(404).send('No such saved meal');
    const name = String(req.body.name || '').trim();
    await t.update({
        name: name || t.name,
        mealType: ['breakfast', 'lunch', 'dinner', 'snack'].includes(req.body.mealType) ? req.body.mealType : t.mealType,
        ingredients: JSON.stringify(slotsFromForm(req.body)),
        notes: req.body.notes || null,
    });
    res.redirect('/meal-templates');
});

app.post('/meal-templates/:id/delete', requireLogin, async (req, res) => {
    const { MealTemplate } = getDatabase(req.user.username);
    const t = await MealTemplate.findByPk(req.params.id);
    if (!t) return res.status(404).send('No such saved meal');
    await t.destroy();
    res.redirect('/meal-templates');
});

// Macros without logging anything — so the numbers can be checked, and a slot that
// will not resolve can be found BEFORE it silently drops out of a logged total.
app.post('/meal-templates/:id/preview', requireLogin, async (req, res) => {
    const { MealTemplate, IngredientMatch } = getDatabase(req.user.username);
    const t = await MealTemplate.findByPk(req.params.id);
    if (!t) return res.status(404).json({ error: 'No such saved meal' });
    const result = await macrosForTemplate(parseSlots(t), {
        IngredientMatch, apiKey: process.env.FDC_API_KEY,
        servings: req.body.servings || 1,
    });
    res.json({ ok: true, name: t.name, ...result });
});

app.post('/meal-templates/:id/log', requireLogin, async (req, res) => {
    const { MealTemplate, Meal, IngredientMatch } = getDatabase(req.user.username);
    const t = await MealTemplate.findByPk(req.params.id);
    if (!t) return res.status(404).send('No such saved meal');

    const slots = parseSlots(t);
    const servings = Number(req.body.servings) > 0 ? Number(req.body.servings) : 1;
    const result = await macrosForTemplate(slots, {
        IngredientMatch, apiKey: process.env.FDC_API_KEY, servings,
    });

    const now = new Date();
    await Meal.create({
        date:     req.body.date || now.toISOString().slice(0, 10),
        time:     req.body.time || now.toTimeString().slice(0, 8),
        mealType: ['breakfast', 'lunch', 'dinner', 'snack'].includes(req.body.mealType) ? req.body.mealType : t.mealType,
        description: describe(t.name, slots, servings),
        calories: result.totals.kcal    || null,
        protein:  result.totals.protein || null,
        carbs:    result.totals.carbs   || null,
        fats:     result.totals.fats    || null,
        // What went into the number, so a wrong total can be explained later
        // instead of merely doubted.
        notes: [t.notes, provenance(result)].filter(Boolean).join('\n'),
    });

    // An uncounted ingredient is carried back to the page. Logging a shake that
    // quietly lost its peanut butter is how a nutrition log stops being worth
    // keeping, and the user should see it at the moment it happens.
    const missed = result.skipped.length
        ? `Not counted: ${result.skipped.map(s => s.name).join(', ')} — the total is low by these.`
        : '';
    res.redirect('/meal-templates?logged=' + encodeURIComponent(`${t.name} · ${result.totals.kcal} kcal, ${result.totals.protein}g protein`)
        + (missed ? '&missed=' + encodeURIComponent(missed) : ''));
});

// ── Meal preps: a batch cooked from a saved meal ─────────────────────────────
//
// "I made three of these on Sunday" and then, on three separate days, "log one".
// The macros are computed ONCE here and frozen on the batch — see the MealPrep
// comment in database.js. Logging a portion later copies them out rather than
// recomputing, because by Thursday the template may name a different tub.

app.post('/meal-templates/:id/prep', requireLogin, async (req, res) => {
    const { MealTemplate, MealPrep, IngredientMatch } = getDatabase(req.user.username);
    const t = await MealTemplate.findByPk(req.params.id);
    if (!t) return res.status(404).send('No such saved meal');

    const slots = parseSlots(t);

    // servings: 1 — the batch's macros are per PORTION, so the template is
    // costed once and the count is carried separately. See snapshotFor().
    const result = await macrosForTemplate(slots, {
        IngredientMatch, apiKey: process.env.FDC_API_KEY, servings: 1,
    });

    const row = snapshotFor(t, slots, result, {
        portions: req.body.portions,
        preppedOn: req.body.preppedOn,
        notes: req.body.notes,
    });
    const portions = row.portions;
    await MealPrep.create({ ...row, provenance: provenance(result) });

    // Same warning as logging: a batch whose peanut butter did not resolve is
    // low by that much in every portion it will ever produce, and this is the
    // one moment where fixing it costs nothing.
    const missed = result.skipped.length
        ? `Not counted: ${result.skipped.map(s => s.name).join(', ')} — every portion of this batch is low by these.`
        : '';
    res.redirect('/meal-templates?logged=' + encodeURIComponent(`${portions} × ${t.name} prepped`)
        + (missed ? '&missed=' + encodeURIComponent(missed) : ''));
});

app.post('/meal-preps/:id/log', requireLogin, async (req, res) => {
    const { MealPrep, Meal } = getDatabase(req.user.username);
    const p = await MealPrep.findByPk(req.params.id);
    if (!p) return res.status(404).send('No such meal prep');
    if (isFinished(p)) return res.redirect('/meal-templates?missed=' +
        encodeURIComponent(`${p.name} is finished — nothing left to log.`));

    await Meal.create(mealFor(p, req.body));

    // Decrement after the Meal row exists: if the write above throws, the
    // portion is still in the fridge and still counted. The opposite order
    // loses a portion to an error and there is no way to notice.
    await p.update({ portionsLeft: p.portionsLeft - 1 });

    const left = p.portionsLeft;
    res.redirect('/meal-templates?logged=' + encodeURIComponent(
        `${p.name} · ${p.kcal || 0} kcal, ${p.protein || 0}g protein — ${left} left`));
});

// Threw the rest out, or ate two at once and the count drifted. Correcting the
// count is not the same as logging: this must not write a Meal row.
app.post('/meal-preps/:id/adjust', requireLogin, async (req, res) => {
    const { MealPrep } = getDatabase(req.user.username);
    const p = await MealPrep.findByPk(req.params.id);
    if (!p) return res.status(404).send('No such meal prep');
    await p.update({ portionsLeft: clampPortions(req.body.portionsLeft, p.portions) });
    res.redirect('/meal-templates');
});

app.post('/meal-preps/:id/delete', requireLogin, async (req, res) => {
    const { MealPrep } = getDatabase(req.user.username);
    const p = await MealPrep.findByPk(req.params.id);
    if (!p) return res.status(404).send('No such meal prep');
    await p.destroy();
    res.redirect('/meal-templates');
});

// Goals routes
app.get('/goals', requireLogin, async (req, res) => {
    const { Goal } = getDatabase(req.user.username);
    const goals = await Goal.findAll({ order: [['completed', 'ASC'], ['deadline', 'ASC']] });
    res.render('goals', { title: 'Goals', goals, user: req.user });
});

app.post('/goals', requireLogin, async (req, res) => {
    const { Goal } = getDatabase(req.user.username);
    await Goal.create(req.body);
    res.redirect('/goals');
});

app.post('/goals/toggle/:id', requireLogin, async (req, res) => {
    const { Goal } = getDatabase(req.user.username);
    const goal = await Goal.findByPk(req.params.id);
    goal.completed = !goal.completed;
    await goal.save();
    res.redirect('/goals');
});

app.post('/goals/delete/:id', requireLogin, async (req, res) => {
    const { Goal } = getDatabase(req.user.username);
    await Goal.destroy({ where: { id: req.params.id } });
    res.redirect('/goals');
});

// API endpoints for charts
app.get('/api/weight-data', requireLogin, async (req, res) => {
    const { WeightEntry } = getDatabase(req.user.username);
    const entries = await WeightEntry.findAll({ 
        order: [['date', 'ASC']], 
        limit: 90 
    });
    res.json(entries);
});

// User settings routes
app.get('/settings', requireLogin, (req, res) => {
    res.render('settings', { title: 'Account Settings', user: req.user, error: null, success: null });
});

app.post('/settings/change-password', requireLogin, async (req, res) => {
    // Password updates are managed by the centralized auth service.
    res.render('settings', {
        title: 'Account Settings',
        user: req.user,
        error: 'Password changes are handled by octopus-auth and are not available from this app yet.',
        success: null
    });
});

app.post('/settings/delete-account', requireLogin, async (req, res) => {
    res.render('settings', {
        title: 'Account Settings',
        user: req.user,
        error: 'Account deletion must be performed via octopus-auth and is not available from this app yet.',
        success: null
    });
});

// ── Routines (warmup / stretching / cooldown) ─────────────────────────────────

function parseRoutineItems(itemsText) {
    try {
        return JSON.parse(itemsText || '[]');
    } catch {
        return [];
    }
}

function mapRoutineForClient(routine) {
    return {
        ...routine.toJSON(),
        itemsList: parseRoutineItems(routine.items),
    };
}

app.get('/stretch', requireLogin, async (req, res) => {
    const { Routine, ExerciseDefinition, sequelize } = getDatabase(req.user.username);
    await sequelize.sync();

    const all = await Routine.findAll({ order: [['type', 'ASC'], ['name', 'ASC']] });
    const routines = all.map(mapRoutineForClient);
    const allExercises = await ExerciseDefinition.findAll({ order: [['name', 'ASC']] });
    const exerciseLibrary = allExercises.map(e => ({
        id: e.id,
        name: e.name,
        category: e.category,
        equipment: e.equipment,
        instructions: e.instructions || null,
        videoUrl: e.videoUrl || null,
        defaultSets: e.defaultSets || null,
        defaultReps: e.defaultReps || null,
        defaultDuration: e.defaultDuration || null,
    }));

    res.render('stretch', {
        title: 'Stretch Builder',
        user: req.user,
        routines,
        exerciseLibrary,
    });
});

app.get('/stretch/api/routines', requireLogin, async (req, res) => {
    const { Routine, sequelize } = getDatabase(req.user.username);
    await sequelize.sync();
    const routines = await Routine.findAll({ order: [['type', 'ASC'], ['name', 'ASC']] });
    res.json({ success: true, data: routines.map(mapRoutineForClient) });
});

app.post('/stretch/api/routines', requireLogin, async (req, res) => {
    const { Routine, sequelize } = getDatabase(req.user.username);
    await sequelize.sync();

    const { name, type, notes, items } = req.body;
    if (!name || !type || !Array.isArray(items)) {
        return res.status(400).json({ success: false, message: 'name, type, and items are required' });
    }

    const routine = await Routine.create({
        name: name.trim(),
        type,
        notes: notes?.trim() || null,
        items: JSON.stringify(items),
    });

    res.json({ success: true, data: mapRoutineForClient(routine) });
});

app.delete('/stretch/api/routines/:id', requireLogin, async (req, res) => {
    const { Routine } = getDatabase(req.user.username);
    await Routine.destroy({ where: { id: req.params.id } });
    res.json({ success: true });
});

app.get('/routines', requireLogin, async (req, res) => {
    res.redirect('/stretch');
});

app.post('/routines', requireLogin, async (req, res) => {
    const { Routine, sequelize } = getDatabase(req.user.username);
    await sequelize.sync();
    const { name, type, notes } = req.body;
    await Routine.create({ name: name.trim(), type, notes: notes?.trim() || null, items: '[]' });
    res.redirect('/routines?success=1');
});

app.post('/routines/update/:id', requireLogin, async (req, res) => {
    const { Routine } = getDatabase(req.user.username);
    const r = await Routine.findByPk(req.params.id);
    if (!r) return res.redirect('/routines');
    const { name, type, notes } = req.body;
    await r.update({ name: name.trim(), type, notes: notes?.trim() || null });
    res.redirect('/routines');
});

app.post('/routines/delete/:id', requireLogin, async (req, res) => {
    const { Routine } = getDatabase(req.user.username);
    await Routine.destroy({ where: { id: req.params.id } });
    res.redirect('/routines');
});

app.post('/routines/:id/items', requireLogin, async (req, res) => {
    const { Routine, ExerciseDefinition } = getDatabase(req.user.username);
    const r = await Routine.findByPk(req.params.id);
    if (!r) return res.redirect('/routines');
    const items = JSON.parse(r.items || '[]');
    const { name, duration, reps, sets, notes, exerciseId, instructions, mediaUrl } = req.body;
    const exerciseIdNum = exerciseId ? parseInt(exerciseId) : null;
    const fromLibrary = exerciseIdNum ? await ExerciseDefinition.findByPk(exerciseIdNum) : null;
    const resolvedName = (name || '').trim() || fromLibrary?.name;
    if (!resolvedName) return res.redirect('/routines');
    items.push({
        name:     resolvedName,
        duration: duration ? parseInt(duration) : null,
        reps:     reps     ? parseInt(reps)     : null,
        sets:     sets     ? parseInt(sets)      : null,
        notes:    notes?.trim() || null,
        exerciseId: exerciseIdNum || fromLibrary?.id || null,
        instructions: (instructions || '').trim() || fromLibrary?.instructions || null,
        mediaUrl: (mediaUrl || '').trim() || fromLibrary?.videoUrl || null,
    });
    await r.update({ items: JSON.stringify(items) });
    res.redirect('/routines');
});

app.post('/routines/:id/items/update/:idx', requireLogin, async (req, res) => {
    const { Routine, ExerciseDefinition } = getDatabase(req.user.username);
    const r = await Routine.findByPk(req.params.id);
    if (!r) return res.redirect('/routines');
    const items = JSON.parse(r.items || '[]');
    const idx = parseInt(req.params.idx);
    if (idx >= 0 && idx < items.length) {
        const existing = items[idx] || {};
        const { name, duration, reps, sets, notes, exerciseId, instructions, mediaUrl } = req.body;
        const exerciseIdNum = exerciseId ? parseInt(exerciseId) : existing.exerciseId || null;
        const fromLibrary = exerciseIdNum ? await ExerciseDefinition.findByPk(exerciseIdNum) : null;
        const resolvedName = (name || '').trim() || fromLibrary?.name || existing.name;
        items[idx] = {
            name:     resolvedName,
            duration: duration ? parseInt(duration) : null,
            reps:     reps     ? parseInt(reps)     : null,
            sets:     sets     ? parseInt(sets)      : null,
            notes:    notes?.trim() || null,
            exerciseId: exerciseIdNum || null,
            instructions: (instructions || '').trim() || fromLibrary?.instructions || existing.instructions || null,
            mediaUrl: (mediaUrl || '').trim() || fromLibrary?.videoUrl || existing.mediaUrl || null,
        };
    }
    await r.update({ items: JSON.stringify(items) });
    res.redirect('/routines');
});

app.post('/routines/:id/items/delete/:idx', requireLogin, async (req, res) => {
    const { Routine } = getDatabase(req.user.username);
    const r = await Routine.findByPk(req.params.id);
    if (!r) return res.redirect('/routines');
    const items = JSON.parse(r.items || '[]');
    items.splice(parseInt(req.params.idx), 1);
    await r.update({ items: JSON.stringify(items) });
    res.redirect('/routines');
});

// ── Planner ───────────────────────────────────────────────────────────────────

const parseArr = (s) => { try { return JSON.parse(s || '[]'); } catch { return []; } };

const SESSION_TYPES = {
    strength:     '💪 Strength',
    conditioning: '🏃 Conditioning',
    technique:    '🎯 Technique',
    recovery:     '🧘 Recovery',
    bjj:          '🥋 BJJ',
    muay_thai:    '🥊 Muay Thai',
    open_mat:     '🤸 Open Mat',
    gym_work:     '🏋️ Gym Work',
};

app.get('/planner', requireLogin, async (req, res) => {
    const { ScheduleProfile, TrainingSession, Competition, sequelize } = getDatabase(req.user.username);
    await sequelize.sync();

    const schedule = await ScheduleProfile.findOne();
    const scheduleData = schedule ? {
        workDays:       parseArr(schedule.workDays),
        workShiftStart: schedule.workShiftStart || '',
        workShiftEnd:   schedule.workShiftEnd   || '',
        bjjDays:        parseArr(schedule.bjjDays),
        muayThaiDays:   parseArr(schedule.muayThaiDays),
        openMatDays:    parseArr(schedule.openMatDays),
    } : { workDays: [], workShiftStart: '', workShiftEnd: '', bjjDays: [], muayThaiDays: [], openMatDays: [] };

    const todayStr = new Date().toISOString().split('T')[0];
    const twoWeeksStr = new Date(Date.now() + 14 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const sevenDaysAgoStr = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

    const upcomingSessions = await TrainingSession.findAll({
        where: { date: { [Op.between]: [todayStr, twoWeeksStr] } },
        order: [['date', 'ASC']],
    });
    const recentSessions = await TrainingSession.findAll({
        where: { date: { [Op.between]: [sevenDaysAgoStr, new Date(todayStr + 'T00:00:00').toISOString().split('T')[0]] } },
        order: [['date', 'DESC']],
    });
    const competitions = await Competition.findAll({
        where: { isActive: true, date: { [Op.gte]: todayStr } },
        order: [['date', 'ASC']],
    });

    res.render('planner', {
        title: 'Training Planner',
        user: req.user,
        scheduleData,
        upcomingSessions,
        recentSessions,
        competitions,
        sessionTypes: SESSION_TYPES,
        todayStr,
        success: req.query.success || null,
    });
});

app.post('/planner/schedule', requireLogin, async (req, res) => {
    const { ScheduleProfile, sequelize } = getDatabase(req.user.username);
    await sequelize.sync();

    const workDays    = [].concat(req.body.workDays    || []).map(Number);
    const bjjDays     = [].concat(req.body.bjjDays     || []).map(Number);
    const muayThaiDays= [].concat(req.body.muayThaiDays|| []).map(Number);
    const openMatDays = [].concat(req.body.openMatDays || []).map(Number);
    const data = {
        workDays:       JSON.stringify(workDays),
        workShiftStart: req.body.workShiftStart || null,
        workShiftEnd:   req.body.workShiftEnd   || null,
        bjjDays:        JSON.stringify(bjjDays),
        muayThaiDays:   JSON.stringify(muayThaiDays),
        openMatDays:    JSON.stringify(openMatDays),
    };

    const existing = await ScheduleProfile.findOne();
    if (existing) await existing.update(data);
    else await ScheduleProfile.create(data);

    res.redirect('/planner?success=1');
});

app.post('/planner/session', requireLogin, async (req, res) => {
    const { TrainingSession, sequelize } = getDatabase(req.user.username);
    await sequelize.sync();

    const { date, type, title, plannedDuration, notes, competitionId } = req.body;
    await TrainingSession.create({
        date,
        type,
        title:           title           || null,
        plannedDuration: plannedDuration ? parseInt(plannedDuration) : null,
        notes:           notes           || null,
        competitionId:   competitionId   ? parseInt(competitionId)   : null,
        status:          'planned',
    });
    res.redirect('/planner?success=1');
});

app.post('/planner/session/update/:id', requireLogin, async (req, res) => {
    const { TrainingSession } = getDatabase(req.user.username);
    const s = await TrainingSession.findByPk(req.params.id);
    if (!s) return res.redirect('/planner');

    const { status, actualDuration, effort, energy, notes, missedReason } = req.body;
    await s.update({
        status:         status         || s.status,
        actualDuration: actualDuration ? parseInt(actualDuration) : s.actualDuration,
        effort:         effort         ? parseInt(effort)         : s.effort,
        energy:         energy         ? parseInt(energy)         : s.energy,
        notes:          notes          !== undefined ? notes       : s.notes,
        missedReason:   missedReason   || s.missedReason,
    });
    res.redirect('/planner');
});

app.post('/planner/session/delete/:id', requireLogin, async (req, res) => {
    const { TrainingSession } = getDatabase(req.user.username);
    await TrainingSession.destroy({ where: { id: req.params.id } });
    res.redirect('/planner');
});

// ── Competitions ──────────────────────────────────────────────────────────────

const SPORT_LABELS = { muay_thai: '🥊 Muay Thai', bjj: '🥋 BJJ', other: '🏆 Other' };

app.get('/competitions', requireLogin, async (req, res) => {
    const { Competition, sequelize } = getDatabase(req.user.username);
    await sequelize.sync();

    const all = await Competition.findAll({ order: [['date', 'ASC']] });
    const todayStr = new Date().toISOString().split('T')[0];

    const enriched = all.map(c => {
        const daysOut  = Math.ceil((new Date(c.date) - new Date()) / (24 * 60 * 60 * 1000));
        const phase    = getPeriodisationPhase(c.date);
        let regWarning = null;
        if (c.registrationDeadline) {
            const regDays = Math.ceil((new Date(c.registrationDeadline) - new Date()) / (24 * 60 * 60 * 1000));
            if (regDays > 0 && regDays <= 14) regWarning = regDays;
        }
        return { ...c.toJSON(), daysOut, phase, regWarning, isPast: daysOut < 0 };
    });

    res.render('competitions', {
        title: 'Competitions',
        user: req.user,
        competitions: enriched,
        sportLabels: SPORT_LABELS,
        todayStr,
    });
});

app.post('/competitions', requireLogin, async (req, res) => {
    const { Competition, sequelize } = getDatabase(req.user.username);
    await sequelize.sync();

    const { name, sport, date, location, weightClass, registrationDeadline, notes } = req.body;
    await Competition.create({
        name, sport, date,
        location:             location             || null,
        weightClass:          weightClass          || null,
        registrationDeadline: registrationDeadline || null,
        notes:                notes                || null,
        isActive: true,
    });
    res.redirect('/competitions');
});

app.post('/competitions/delete/:id', requireLogin, async (req, res) => {
    const { Competition } = getDatabase(req.user.username);
    await Competition.destroy({ where: { id: req.params.id } });
    res.redirect('/competitions');
});

// ── Accountability ────────────────────────────────────────────────────────────

app.get('/accountability', requireLogin, async (req, res) => {
    const { TrainingSession, sequelize } = getDatabase(req.user.username);
    await sequelize.sync();

    const today    = new Date();
    const todayStr = today.toISOString().split('T')[0];

    // 30-day heatmap
    const thirtyStr = new Date(today.getTime() - 29 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
    const heatmapSessions = await TrainingSession.findAll({
        where: { date: { [Op.gte]: thirtyStr } },
    });
    const heatmap = [];
    for (let i = 29; i >= 0; i--) {
        const d = new Date(today.getTime() - i * 24 * 60 * 60 * 1000);
        const ds = d.toISOString().split('T')[0];
        const daySess = heatmapSessions.filter(s => s.date === ds);
        let status = 'empty';
        if (ds > todayStr)                                        status = 'future';
        else if (daySess.some(s => s.status === 'completed'))     status = 'completed';
        else if (daySess.some(s => s.status === 'partial'))       status = 'partial';
        else if (daySess.some(s => s.status === 'missed'))        status = 'missed';
        else if (daySess.some(s => s.status === 'planned'))       status = 'planned';
        heatmap.push({ date: ds, label: `${d.getMonth()+1}/${d.getDate()}`, status, count: daySess.length });
    }

    // Streak (consecutive completed/partial days going back from today)
    const allDone = await TrainingSession.findAll({
        where: { status: { [Op.in]: ['completed', 'partial'] } },
        attributes: ['date'],
    });
    const doneDates = new Set(allDone.map(s => s.date));
    let streak = 0;
    let check  = new Date(today);
    if (!doneDates.has(todayStr)) check.setDate(check.getDate() - 1);
    while (doneDates.has(check.toISOString().split('T')[0])) {
        streak++;
        check.setDate(check.getDate() - 1);
    }

    // This week stats
    const startOfWeek = new Date(today);
    startOfWeek.setDate(today.getDate() - today.getDay());
    const weekStr = startOfWeek.toISOString().split('T')[0];
    const weekSessions = await TrainingSession.findAll({
        where: { date: { [Op.between]: [weekStr, todayStr] } },
    });
    const weekCompleted = weekSessions.filter(s => ['completed','partial'].includes(s.status)).length;
    const weekTotal     = weekSessions.length;

    // Recent history (last 30 sessions)
    const recentSessions = await TrainingSession.findAll({
        order: [['date', 'DESC']],
        limit: 30,
    });

    res.render('accountability', {
        title: 'Accountability',
        user: req.user,
        heatmap,
        streak,
        weekCompleted,
        weekTotal,
        recentSessions,
        sessionTypes: SESSION_TYPES,
        todayStr,
    });
});

// ── Workout Logger ────────────────────────────────────────────────────────────

app.get('/workout', requireLogin, async (req, res) => {
    const { WorkoutSession, WorkoutSet, TrainingPlan, TrainingPlanAssignment, WorkoutTemplate, sequelize } = getDatabase(req.user.username);
    await sequelize.sync();
    const recent = await WorkoutSession.findAll({ order: [['date','DESC'],['startedAt','DESC']], limit: 10 });
    const recentWithCounts = await Promise.all(recent.map(async s => {
        const sets = await WorkoutSet.findAll({ where: { sessionId: s.id } });
        const exCount = new Set(sets.map(x => x.exerciseOrder)).size;
        return { ...s.toJSON(), setCount: sets.length, exerciseCount: exCount };
    }));
    // Active plan today
    const assignment = await TrainingPlanAssignment.findOne({ where: { status: 'active' } });
    let todayPlan = null;
    if (assignment) {
        const plan = await TrainingPlan.findByPk(assignment.planId);
        if (plan) {
            const phases = JSON.parse(plan.phases || '[]');
            const weekNumber = Math.floor((new Date() - new Date(assignment.startDate)) / (7*24*60*60*1000)) + 1;
            const dayOfWeek  = new Date().getDay();
            let phase = phases[0];
            for (const p of phases) {
                const [s, e] = p.weeks.split('–').map(Number);
                if (weekNumber >= s && weekNumber <= e) { phase = p; break; }
            }
            todayPlan = { planName: plan.name, phase: phase?.name, session: phase?.weeklySchedule?.find(d => d.day === dayOfWeek) || null };
        }
    }
    const rawTemplates = await WorkoutTemplate.findAll({ order: [['name','ASC']] });
    const templates = rawTemplates.map(t => ({ ...t.toJSON(), exercises: JSON.parse(t.exercises || '[]') }));
    res.render('workout', { title: 'Workout Logger', user: req.user, recentWorkouts: recentWithCounts, todayPlan, templates });
});

// Workout AJAX endpoints (session-protected, used by workout.ejs)
app.post('/workout/api/session', requireLogin, async (req, res) => {
    const { WorkoutSession, sequelize } = getDatabase(req.user.username);
    await sequelize.sync();
    const { type, title, date } = req.body;
    const session = await WorkoutSession.create({ type, title: title || null, date: date || new Date().toISOString().split('T')[0], startedAt: new Date(), status: 'active' });
    res.json({ success: true, data: session });
});

app.patch('/workout/api/session/:id', requireLogin, async (req, res) => {
    const { WorkoutSession } = getDatabase(req.user.username);
    const s = await WorkoutSession.findByPk(req.params.id);
    if (!s) return res.status(404).json({ success: false });
    if (req.body.status === 'finished') { s.finishedAt = new Date(); s.status = 'finished'; }
    if (req.body.effort   !== undefined) s.effort   = req.body.effort;
    if (req.body.duration !== undefined) s.duration = req.body.duration;
    if (req.body.notes    !== undefined) s.notes    = req.body.notes;
    await s.save();
    res.json({ success: true, data: s });
});

app.delete('/workout/api/session/:id', requireLogin, async (req, res) => {
    const { WorkoutSession, WorkoutSet } = getDatabase(req.user.username);
    await WorkoutSet.destroy({ where: { sessionId: req.params.id } });
    await WorkoutSession.destroy({ where: { id: req.params.id } });
    res.json({ success: true });
});

app.get('/workout/api/session/:id', requireLogin, async (req, res) => {
    const { WorkoutSession, WorkoutSet } = getDatabase(req.user.username);
    const session = await WorkoutSession.findByPk(req.params.id);
    if (!session) return res.status(404).json({ success: false });
    const sets = await WorkoutSet.findAll({ where: { sessionId: req.params.id }, order: [['exerciseOrder','ASC'],['setNumber','ASC']] });
    res.json({ success: true, data: { ...session.toJSON(), sets } });
});

app.post('/workout/api/session/:id/set', requireLogin, async (req, res) => {
    const { WorkoutSet, sequelize } = getDatabase(req.user.username);
    await sequelize.sync();
    const { exerciseName, exerciseId, exerciseOrder, setNumber, reps, weight, weightUnit, duration, rpe, notes } = req.body;
    const set = await WorkoutSet.create({
        sessionId: req.params.id, exerciseName, exerciseId: exerciseId || null,
        exerciseOrder: exerciseOrder || 0, setNumber: setNumber || 1,
        reps: reps || null, weight: weight || null, weightUnit: weightUnit || 'lbs',
        duration: duration || null, rpe: rpe || null, notes: notes || null,
    });
    res.json({ success: true, data: set });
});

app.delete('/workout/api/set/:id', requireLogin, async (req, res) => {
    const { WorkoutSet } = getDatabase(req.user.username);
    await WorkoutSet.destroy({ where: { id: req.params.id } });
    res.json({ success: true });
});

app.get('/workout/api/exercises', requireLogin, async (req, res) => {
    const { ExerciseDefinition } = getDatabase(req.user.username);
    const { q, category } = req.query;
    let all = await ExerciseDefinition.findAll({ order: [['name','ASC']] });
    if (category) all = all.filter(e => e.category === category);
    if (q) all = all.filter(e => e.name.toLowerCase().includes(q.toLowerCase()));
    res.json({ success: true, data: all.map(e => ({ id: e.id, name: e.name, category: e.category, equipment: e.equipment, primaryMuscles: JSON.parse(e.primaryMuscles || '[]'), defaultSets: e.defaultSets, defaultReps: e.defaultReps })) });
});

// Workout templates API
app.get('/workout/api/templates', requireLogin, async (req, res) => {
    const { WorkoutTemplate, sequelize } = getDatabase(req.user.username);
    await sequelize.sync();
    const templates = await WorkoutTemplate.findAll({ order: [['name','ASC']] });
    res.json({ success: true, data: templates.map(t => ({ ...t.toJSON(), exercises: JSON.parse(t.exercises || '[]') })) });
});

app.post('/workout/api/templates', requireLogin, async (req, res) => {
    const { WorkoutTemplate, sequelize } = getDatabase(req.user.username);
    await sequelize.sync();
    const { name, type, description, exercises } = req.body;
    if (!name || !Array.isArray(exercises)) return res.status(400).json({ success: false, message: 'name and exercises required' });
    const t = await WorkoutTemplate.create({ name: name.trim(), type: type || 'strength', description: description?.trim() || null, exercises: JSON.stringify(exercises) });
    res.json({ success: true, data: { ...t.toJSON(), exercises } });
});

app.delete('/workout/api/templates/:id', requireLogin, async (req, res) => {
    const { WorkoutTemplate } = getDatabase(req.user.username);
    await WorkoutTemplate.destroy({ where: { id: req.params.id } });
    res.json({ success: true });
});

// ── Exercise Library ──────────────────────────────────────────────────────────

app.get('/exercises', requireLogin, async (req, res) => {
    const { ExerciseDefinition, sequelize } = getDatabase(req.user.username);
    await sequelize.sync();
    const all = await ExerciseDefinition.findAll({ order: [['category','ASC'],['name','ASC']] });
    const exercises = all.map(e => ({
        ...e.toJSON(),
        primaryMuscles:   JSON.parse(e.primaryMuscles   || '[]'),
        secondaryMuscles: JSON.parse(e.secondaryMuscles || '[]'),
    }));
    res.render('library', { title: 'Exercises', user: req.user, exercises });
});

app.get('/library', requireLogin, async (req, res) => {
    const { ExerciseDefinition, sequelize } = getDatabase(req.user.username);
    await sequelize.sync();
    const all = await ExerciseDefinition.findAll({ order: [['category','ASC'],['name','ASC']] });
    const exercises = all.map(e => ({
        ...e.toJSON(),
        primaryMuscles:   JSON.parse(e.primaryMuscles   || '[]'),
        secondaryMuscles: JSON.parse(e.secondaryMuscles || '[]'),
    }));
    res.render('library', { title: 'Exercise Library', user: req.user, exercises });
});

// ── Exercise Plan Maker ───────────────────────────────────────────────────────

app.get('/plan-maker', requireLogin, async (req, res) => {
    const { ExerciseDefinition, ExercisePlan, sequelize } = getDatabase(req.user.username);
    await sequelize.sync();
    const all = await ExerciseDefinition.findAll({ order: [['category','ASC'],['name','ASC']] });
    const exercises = all.map(e => ({
        ...e.toJSON(),
        primaryMuscles:   JSON.parse(e.primaryMuscles   || '[]'),
        secondaryMuscles: JSON.parse(e.secondaryMuscles || '[]'),
    }));
    const rawPlans = await ExercisePlan.findAll({ order: [['updatedAt','DESC']] });
    const plans = rawPlans.map(p => ({ ...p.toJSON(), items: JSON.parse(p.items || '[]') }));
    res.render('plan-maker', { title: 'Plan Maker', user: req.user, exercises, plans });
});

// ── Timers ────────────────────────────────────────────────────────────────────

app.get('/timers', requireLogin, (req, res) => {
    res.render('timers', { title: 'Timers', user: req.user });
});

// ── Training Plans ────────────────────────────────────────────────────────────

app.get('/plans', requireLogin, async (req, res) => {
    const { TrainingPlan, TrainingPlanAssignment, sequelize } = getDatabase(req.user.username);
    await sequelize.sync();
    const plans = await TrainingPlan.findAll({ order: [['sport','ASC'],['name','ASC']] });
    const assignment = await TrainingPlanAssignment.findOne({ where: { status: 'active' } });
    let activePlan = null;
    let todaySession = null;
    if (assignment) {
        activePlan = plans.find(p => p.id === assignment.planId);
        if (activePlan) {
            const phases = JSON.parse(activePlan.phases || '[]');
            const weekNumber = Math.floor((new Date() - new Date(assignment.startDate)) / (7*24*60*60*1000)) + 1;
            const dayOfWeek = new Date().getDay();
            let phase = phases[0];
            for (const p of phases) {
                const [s, e] = p.weeks.split('–').map(Number);
                if (weekNumber >= s && weekNumber <= e) { phase = p; break; }
            }
            todaySession = { phase: phase?.name, weekNumber, session: phase?.weeklySchedule?.find(d => d.day === dayOfWeek) || null };
        }
    }
    const parsedPlans = plans.map(p => ({ ...p.toJSON(), phases: JSON.parse(p.phases || '[]') }));
    res.render('plans', { title: 'Training Plans', user: req.user, plans: parsedPlans, assignment, activePlan, todaySession });
});

app.post('/plans/assign', requireLogin, async (req, res) => {
    const { TrainingPlanAssignment, sequelize } = getDatabase(req.user.username);
    await sequelize.sync();
    const { planId, startDate } = req.body;
    await TrainingPlanAssignment.update({ status: 'paused' }, { where: { status: 'active' } });
    await TrainingPlanAssignment.create({ planId, startDate: startDate || new Date().toISOString().split('T')[0], status: 'active' });
    res.redirect('/plans');
});

app.post('/plans/unassign', requireLogin, async (req, res) => {
    const { TrainingPlanAssignment } = getDatabase(req.user.username);
    await TrainingPlanAssignment.update({ status: 'paused' }, { where: { status: 'active' } });
    res.redirect('/plans');
});

app.get('/stats', requireLogin, (req, res) => {
    res.render('stats', { title: 'Stats & History', user: req.user });
});

// ─────────────────────────────────────────────────────────────────────────────

// Anything reaching here failed rather than answered. This app serves both
// pages and JSON, so it has to reply in kind: an HTML error page to a browser
// and JSON to fetch(), because an HTML error body breaks the caller's r.json()
// and produces the same silent nothing as the hang it is replacing.
app.use((err, req, res, next) => {
    console.error(`[health] ${req.method} ${req.originalUrl} failed:`, err);
    if (res.headersSent) return next(err);
    const wantsJson = req.originalUrl.startsWith('/api/') ||
                      (req.get('accept') || '').includes('application/json');
    if (wantsJson) {
        return res.status(500).json({ error: err.message || 'internal error' });
    }
    res.status(500).send(
        '<h1>Something went wrong</h1>' +
        '<p>That request failed. The error is in the server log.</p>' +
        '<p><a href="/">Back</a></p>');
});

app.listen(port, () => {
    console.log(`Health Tracker running on port ${port}`);
});
