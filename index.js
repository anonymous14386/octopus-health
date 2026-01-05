const express = require('express');
const session = require('express-session');
const bodyParser = require('body-parser');
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const app = express();
const port = process.env.PORT || 3000;
const getDatabase = require('./database');

// Ensure data directory exists
const dataDir = path.join(__dirname, 'data');
if (!fs.existsSync(dataDir)) {
    fs.mkdirSync(dataDir, { recursive: true });
}

// View engine setup
app.set('view engine', 'ejs');
app.set('views', './views');

// Middleware
app.use(express.urlencoded({ extended: true }));
app.use(express.json());
app.use(bodyParser.urlencoded({ extended: true }));
app.use(session({
    secret: process.env.SESSION_SECRET || 'change-me-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: { 
        secure: false,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Auth middleware
const requireLogin = (req, res, next) => {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/login');
    }
};

// Routes
app.get('/login', (req, res) => {
    res.render('login', { title: 'Login', error: null });
});

app.post('/login', (req, res) => {
    const { username, password } = req.body;
    const validPassword = process.env.APP_PASSWORD || 'password';
    
    if (password === validPassword && username && username.length > 0) {
        req.session.user = { username };
        const { sequelize } = getDatabase(username);
        sequelize.sync();
        res.redirect('/');
    } else {
        res.render('login', { title: 'Login', error: 'Invalid credentials' });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

// Dashboard
app.get('/', requireLogin, async (req, res) => {
    const { WeightEntry, Exercise, Meal, Goal } = getDatabase(req.session.user.username);
    
    try {
        // Get recent data
        const recentWeight = await WeightEntry.findOne({ 
            order: [['date', 'DESC']] 
        });
        const todayExercises = await Exercise.findAll({
            where: { 
                date: new Date().toISOString().split('T')[0] 
            }
        });
        const todayMeals = await Meal.findAll({
            where: { 
                date: new Date().toISOString().split('T')[0] 
            }
        });
        const activeGoals = await Goal.findAll({
            where: { completed: false }
        });

        // Calculate today's totals
        const todayCalories = todayMeals.reduce((sum, meal) => sum + (meal.calories || 0), 0);
        const todayExerciseMinutes = todayExercises.reduce((sum, ex) => sum + ex.duration, 0);

        res.render('index', {
            title: 'Health Tracker Dashboard',
            user: req.session.user,
            recentWeight,
            todayExercises,
            todayMeals,
            activeGoals,
            todayCalories,
            todayExerciseMinutes
        });
    } catch (error) {
        console.error(error);
        res.status(500).send('Error loading dashboard');
    }
});

// Weight tracking routes
app.get('/weight', requireLogin, async (req, res) => {
    const { WeightEntry } = getDatabase(req.session.user.username);
    const entries = await WeightEntry.findAll({ 
        order: [['date', 'DESC']], 
        limit: 30 
    });
    res.render('weight', { title: 'Weight Tracking', entries, user: req.session.user });
});

app.post('/weight', requireLogin, async (req, res) => {
    const { WeightEntry } = getDatabase(req.session.user.username);
    await WeightEntry.create(req.body);
    res.redirect('/weight');
});

app.post('/weight/delete/:id', requireLogin, async (req, res) => {
    const { WeightEntry } = getDatabase(req.session.user.username);
    await WeightEntry.destroy({ where: { id: req.params.id } });
    res.redirect('/weight');
});

// Exercise tracking routes
app.get('/exercise', requireLogin, async (req, res) => {
    const { Exercise } = getDatabase(req.session.user.username);
    const exercises = await Exercise.findAll({ 
        order: [['date', 'DESC']], 
        limit: 30 
    });
    res.render('exercise', { title: 'Exercise Tracking', exercises, user: req.session.user });
});

app.post('/exercise', requireLogin, async (req, res) => {
    const { Exercise } = getDatabase(req.session.user.username);
    await Exercise.create(req.body);
    res.redirect('/exercise');
});

app.post('/exercise/delete/:id', requireLogin, async (req, res) => {
    const { Exercise } = getDatabase(req.session.user.username);
    await Exercise.destroy({ where: { id: req.params.id } });
    res.redirect('/exercise');
});

// Meal/Food tracking routes
app.get('/meals', requireLogin, async (req, res) => {
    const { Meal } = getDatabase(req.session.user.username);
    const meals = await Meal.findAll({ 
        order: [['date', 'DESC'], ['time', 'DESC']], 
        limit: 30 
    });
    res.render('meals', { title: 'Food Tracking', meals, user: req.session.user });
});

app.post('/meals', requireLogin, async (req, res) => {
    const { Meal } = getDatabase(req.session.user.username);
    await Meal.create(req.body);
    res.redirect('/meals');
});

app.post('/meals/delete/:id', requireLogin, async (req, res) => {
    const { Meal } = getDatabase(req.session.user.username);
    await Meal.destroy({ where: { id: req.params.id } });
    res.redirect('/meals');
});

// Goals routes
app.get('/goals', requireLogin, async (req, res) => {
    const { Goal } = getDatabase(req.session.user.username);
    const goals = await Goal.findAll({ order: [['completed', 'ASC'], ['deadline', 'ASC']] });
    res.render('goals', { title: 'Goals', goals, user: req.session.user });
});

app.post('/goals', requireLogin, async (req, res) => {
    const { Goal } = getDatabase(req.session.user.username);
    await Goal.create(req.body);
    res.redirect('/goals');
});

app.post('/goals/toggle/:id', requireLogin, async (req, res) => {
    const { Goal } = getDatabase(req.session.user.username);
    const goal = await Goal.findByPk(req.params.id);
    goal.completed = !goal.completed;
    await goal.save();
    res.redirect('/goals');
});

app.post('/goals/delete/:id', requireLogin, async (req, res) => {
    const { Goal } = getDatabase(req.session.user.username);
    await Goal.destroy({ where: { id: req.params.id } });
    res.redirect('/goals');
});

// API endpoints for charts
app.get('/api/weight-data', requireLogin, async (req, res) => {
    const { WeightEntry } = getDatabase(req.session.user.username);
    const entries = await WeightEntry.findAll({ 
        order: [['date', 'ASC']], 
        limit: 90 
    });
    res.json(entries);
});

app.listen(port, () => {
    console.log(`Health Tracker running on port ${port}`);
});
