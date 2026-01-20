const express = require('express');
const session = require('express-session');
const SQLiteStore = require('connect-sqlite3')(session);
const bodyParser = require('body-parser');
const bcrypt = require('bcrypt');
const jwt = require('jsonwebtoken');
const fs = require('fs');
const path = require('path');
const { Op } = require('sequelize');
const app = express();
const port = process.env.PORT || 3000;
const getDatabase = require('./database');
const { User, authDb } = require('./database');

const JWT_SECRET = process.env.JWT_SECRET || 'change-me-in-production-jwt-secret';

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
    store: new SQLiteStore({ db: 'sessions.sqlite', dir: './data' }),
    secret: process.env.SESSION_SECRET || 'change-me-in-production',
    resave: false,
    saveUninitialized: false,
    cookie: {
        secure: false,
        maxAge: 24 * 60 * 60 * 1000 // 24 hours
    }
}));

// Mount API routes (before session-based routes)
const apiRouter = require('./api');
app.use('/api', apiRouter);

// Auth middleware
const requireLogin = (req, res, next) => {
    if (req.session.user) {
        next();
    } else {
        res.redirect('/login');
    }
};

// JWT middleware for API routes
const requireApiAuth = (req, res, next) => {
    const authHeader = req.headers.authorization;
    if (!authHeader) {
        return res.status(401).json({ success: false, message: 'No token provided' });
    }
    
    const token = authHeader.split(' ')[1]; // Bearer <token>
    if (!token) {
        return res.status(401).json({ success: false, message: 'Invalid token format' });
    }
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded;
        next();
    } catch (error) {
        return res.status(401).json({ success: false, message: 'Invalid or expired token' });
    }
};

// Routes

app.get('/login', (req, res) => {
    const siteKey = process.env.RECAPTCHA_SITE_KEY;
    console.log('RECAPTCHA_SITE_KEY for /login page:', siteKey);
    res.render('login', { title: 'Login', error: null, mode: 'login', siteKey });
});


app.post('/login', async (req, res) => {
    const { username, password } = req.body;
    
    try {
        const user = await User.findOne({ where: { username } });
        
        if (!user) {
            return res.render('login', { title: 'Login', error: 'User not found', mode: 'login', siteKey: process.env.RECAPTCHA_SITE_KEY });
        }
        
        const validPassword = await bcrypt.compare(password, user.password);
        
        if (validPassword) {
            req.session.user = { username };
            const { sequelize } = getDatabase(username);
            await sequelize.sync();
            res.redirect('/');
        } else {
            res.render('login', { title: 'Login', error: 'Invalid password', mode: 'login', siteKey: process.env.RECAPTCHA_SITE_KEY });
        }
    } catch (error) {
        console.error('Login error:', error);
        res.render('login', { title: 'Login', error: 'Login failed', mode: 'login', siteKey: process.env.RECAPTCHA_SITE_KEY });
    }
});


app.get('/register', (req, res) => {
    res.render('login', { title: 'Register', error: null, mode: 'register', siteKey: process.env.RECAPTCHA_SITE_KEY });
});


app.post('/register', async (req, res) => {
    const { username, password, confirmPassword } = req.body;
    
    try {
        if (!username || !password || !confirmPassword) {
            return res.render('login', { title: 'Register', error: 'All fields required', mode: 'register', siteKey: process.env.RECAPTCHA_SITE_KEY });
        }
        
        if (password !== confirmPassword) {
            return res.render('login', { title: 'Register', error: 'Passwords do not match', mode: 'register', siteKey: process.env.RECAPTCHA_SITE_KEY });
        }
        
        if (password.length < 6) {
            return res.render('login', { title: 'Register', error: 'Password must be at least 6 characters', mode: 'register', siteKey: process.env.RECAPTCHA_SITE_KEY });
        }
        
        const existingUser = await User.findOne({ where: { username } });
        if (existingUser) {
            return res.render('login', { title: 'Register', error: 'Username already exists', mode: 'register', siteKey: process.env.RECAPTCHA_SITE_KEY });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        await User.create({ username, password: hashedPassword });
        
        req.session.user = { username };
        const { sequelize } = getDatabase(username);
        await sequelize.sync();
        res.redirect('/');
    } catch (error) {
        console.error('Registration error:', error);
        res.render('login', { title: 'Register', error: 'Registration failed', mode: 'register', siteKey: process.env.RECAPTCHA_SITE_KEY });
    }
});

app.get('/logout', (req, res) => {
    req.session.destroy(() => {
        res.redirect('/login');
    });
});

// REST API endpoints for mobile app
app.post('/api/auth/register', async (req, res) => {
    const { username, password } = req.body;
    
    try {
        if (!username || !password) {
            return res.status(400).json({ success: false, message: 'Username and password required' });
        }
        
        if (password.length < 6) {
            return res.status(400).json({ success: false, message: 'Password must be at least 6 characters' });
        }
        
        const existingUser = await User.findOne({ where: { username } });
        if (existingUser) {
            return res.status(400).json({ success: false, message: 'Username already exists' });
        }
        
        const hashedPassword = await bcrypt.hash(password, 10);
        await User.create({ username, password: hashedPassword });
        
        // Initialize user's database
        const { sequelize } = getDatabase(username);
        await sequelize.sync();
        
        // Generate token
        const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
        
        res.status(201).json({ success: true, token, message: 'User registered successfully' });
    } catch (error) {
        console.error('API registration error:', error);
        res.status(500).json({ success: false, message: 'Registration failed' });
    }
});

app.post('/api/auth/login', async (req, res) => {
    const { username, password } = req.body;
    
    console.log('API login attempt for username:', username);
    
    try {
        const user = await User.findOne({ where: { username } });
        
        if (!user) {
            console.log('User not found');
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }
        
        const validPassword = await bcrypt.compare(password, user.password);
        
        if (!validPassword) {
            console.log('Invalid password');
            return res.status(401).json({ success: false, message: 'Invalid credentials' });
        }
        
        // Ensure user's database is synced
        const { sequelize } = getDatabase(username);
        await sequelize.sync();
        
        // Generate token
        const token = jwt.sign({ username }, JWT_SECRET, { expiresIn: '7d' });
        
        console.log('Login successful, token generated');
        res.json({ success: true, token, message: null });
    } catch (error) {
        console.error('API login error:', error);
        res.status(500).json({ success: false, message: 'Login failed' });
    }
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

// User settings routes
app.get('/settings', requireLogin, (req, res) => {
    res.render('settings', { title: 'Account Settings', user: req.session.user, error: null, success: null });
});

app.post('/settings/change-password', requireLogin, async (req, res) => {
    const { currentPassword, newPassword, confirmPassword } = req.body;
    
    try {
        const user = await User.findOne({ where: { username: req.session.user.username } });
        
        const validPassword = await bcrypt.compare(currentPassword, user.password);
        if (!validPassword) {
            return res.render('settings', { 
                title: 'Account Settings', 
                user: req.session.user, 
                error: 'Current password is incorrect', 
                success: null 
            });
        }
        
        if (newPassword !== confirmPassword) {
            return res.render('settings', { 
                title: 'Account Settings', 
                user: req.session.user, 
                error: 'New passwords do not match', 
                success: null 
            });
        }
        
        if (newPassword.length < 6) {
            return res.render('settings', { 
                title: 'Account Settings', 
                user: req.session.user, 
                error: 'Password must be at least 6 characters', 
                success: null 
            });
        }
        
        const hashedPassword = await bcrypt.hash(newPassword, 10);
        user.password = hashedPassword;
        await user.save();
        
        res.render('settings', { 
            title: 'Account Settings', 
            user: req.session.user, 
            error: null, 
            success: 'Password changed successfully' 
        });
    } catch (error) {
        console.error('Password change error:', error);
        res.render('settings', { 
            title: 'Account Settings', 
            user: req.session.user, 
            error: 'Failed to change password', 
            success: null 
        });
    }
});

app.post('/settings/delete-account', requireLogin, async (req, res) => {
    const { password } = req.body;
    const username = req.session.user.username;
    
    try {
        const user = await User.findOne({ where: { username } });
        
        const validPassword = await bcrypt.compare(password, user.password);
        if (!validPassword) {
            return res.render('settings', { 
                title: 'Account Settings', 
                user: req.session.user, 
                error: 'Incorrect password', 
                success: null 
            });
        }
        
        // Delete user database
        const dbPath = path.join(dataDir, `${username}_health.sqlite`);
        if (fs.existsSync(dbPath)) {
            fs.unlinkSync(dbPath);
        }
        
        // Delete user from auth database
        await user.destroy();
        
        // Destroy session and redirect to login
        req.session.destroy(() => {
            res.redirect('/login');
        });
    } catch (error) {
        console.error('Account deletion error:', error);
        res.render('settings', { 
            title: 'Account Settings', 
            user: req.session.user, 
            error: 'Failed to delete account', 
            success: null 
        });
    }
});

app.listen(port, () => {
    console.log(`Health Tracker running on port ${port}`);
});
