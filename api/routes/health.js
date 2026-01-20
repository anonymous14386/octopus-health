const express = require('express');
const getDatabase = require('../../database');
const { authenticateToken } = require('../middleware/auth');

const router = express.Router();

// Apply authentication to all health routes
router.use(authenticateToken);

// Weight endpoints
router.get('/weight', async (req, res) => {
    try {
        const { WeightEntry } = getDatabase(req.user.username);
        const entries = await WeightEntry.findAll({ 
            order: [['date', 'DESC']]
        });
        res.json({ success: true, data: entries });
    } catch (error) {
        console.error('Error fetching weight entries:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch weight entries' });
    }
});

router.post('/weight', async (req, res) => {
    const { date, weight, notes } = req.body;

    try {
        // Validate input
        if (!date || weight === undefined) {
            return res.status(400).json({ success: false, error: 'Date and weight are required' });
        }

        const { WeightEntry } = getDatabase(req.user.username);
        const entry = await WeightEntry.create({ date, weight, notes });
        res.status(201).json({ success: true, data: entry });
    } catch (error) {
        console.error('Error creating weight entry:', error);
        res.status(500).json({ success: false, error: 'Failed to create weight entry' });
    }
});

router.put('/weight/:id', async (req, res) => {
    const { id } = req.params;
    const { date, weight, notes } = req.body;

    try {
        const { WeightEntry } = getDatabase(req.user.username);
        const entry = await WeightEntry.findByPk(id);

        if (!entry) {
            return res.status(404).json({ success: false, error: 'Weight entry not found' });
        }

        // Update fields
        if (date !== undefined) entry.date = date;
        if (weight !== undefined) entry.weight = weight;
        if (notes !== undefined) entry.notes = notes;

        await entry.save();
        res.json({ success: true, data: entry });
    } catch (error) {
        console.error('Error updating weight entry:', error);
        res.status(500).json({ success: false, error: 'Failed to update weight entry' });
    }
});

router.delete('/weight/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const { WeightEntry } = getDatabase(req.user.username);
        const entry = await WeightEntry.findByPk(id);

        if (!entry) {
            return res.status(404).json({ success: false, error: 'Weight entry not found' });
        }

        await entry.destroy();
        res.json({ success: true, message: 'Weight entry deleted' });
    } catch (error) {
        console.error('Error deleting weight entry:', error);
        res.status(500).json({ success: false, error: 'Failed to delete weight entry' });
    }
});

// Exercise endpoints
router.get('/exercises', async (req, res) => {
    try {
        const { Exercise } = getDatabase(req.user.username);
        const exercises = await Exercise.findAll({ 
            order: [['date', 'DESC']]
        });
        res.json({ success: true, data: exercises });
    } catch (error) {
        console.error('Error fetching exercises:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch exercises' });
    }
});

router.post('/exercises', async (req, res) => {
    const { date, type, duration, notes } = req.body;

    try {
        // Validate input
        if (!date || !type || duration === undefined) {
            return res.status(400).json({ success: false, error: 'Date, type, and duration are required' });
        }

        const { Exercise } = getDatabase(req.user.username);
        const exercise = await Exercise.create({ date, type, duration, notes });
        res.status(201).json({ success: true, data: exercise });
    } catch (error) {
        console.error('Error creating exercise:', error);
        res.status(500).json({ success: false, error: 'Failed to create exercise' });
    }
});

router.put('/exercises/:id', async (req, res) => {
    const { id } = req.params;
    const { date, type, duration, notes } = req.body;

    try {
        const { Exercise } = getDatabase(req.user.username);
        const exercise = await Exercise.findByPk(id);

        if (!exercise) {
            return res.status(404).json({ success: false, error: 'Exercise not found' });
        }

        // Update fields
        if (date !== undefined) exercise.date = date;
        if (type !== undefined) exercise.type = type;
        if (duration !== undefined) exercise.duration = duration;
        if (notes !== undefined) exercise.notes = notes;

        await exercise.save();
        res.json({ success: true, data: exercise });
    } catch (error) {
        console.error('Error updating exercise:', error);
        res.status(500).json({ success: false, error: 'Failed to update exercise' });
    }
});

router.delete('/exercises/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const { Exercise } = getDatabase(req.user.username);
        const exercise = await Exercise.findByPk(id);

        if (!exercise) {
            return res.status(404).json({ success: false, error: 'Exercise not found' });
        }

        await exercise.destroy();
        res.json({ success: true, message: 'Exercise deleted' });
    } catch (error) {
        console.error('Error deleting exercise:', error);
        res.status(500).json({ success: false, error: 'Failed to delete exercise' });
    }
});

// Meals endpoints
router.get('/meals', async (req, res) => {
    try {
        const { Meal } = getDatabase(req.user.username);
        const meals = await Meal.findAll({ 
            order: [['date', 'DESC'], ['time', 'DESC']]
        });
        res.json({ success: true, data: meals });
    } catch (error) {
        console.error('Error fetching meals:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch meals' });
    }
});

router.post('/meals', async (req, res) => {
    const { date, time, description, calories, notes } = req.body;

    try {
        // Validate input
        if (!date || !description) {
            return res.status(400).json({ success: false, error: 'Date and description are required' });
        }

        const { Meal } = getDatabase(req.user.username);
        const meal = await Meal.create({ date, time, description, calories, notes });
        res.status(201).json({ success: true, data: meal });
    } catch (error) {
        console.error('Error creating meal:', error);
        res.status(500).json({ success: false, error: 'Failed to create meal' });
    }
});

router.put('/meals/:id', async (req, res) => {
    const { id } = req.params;
    const { date, time, description, calories, notes } = req.body;

    try {
        const { Meal } = getDatabase(req.user.username);
        const meal = await Meal.findByPk(id);

        if (!meal) {
            return res.status(404).json({ success: false, error: 'Meal not found' });
        }

        // Update fields
        if (date !== undefined) meal.date = date;
        if (time !== undefined) meal.time = time;
        if (description !== undefined) meal.description = description;
        if (calories !== undefined) meal.calories = calories;
        if (notes !== undefined) meal.notes = notes;

        await meal.save();
        res.json({ success: true, data: meal });
    } catch (error) {
        console.error('Error updating meal:', error);
        res.status(500).json({ success: false, error: 'Failed to update meal' });
    }
});

router.delete('/meals/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const { Meal } = getDatabase(req.user.username);
        const meal = await Meal.findByPk(id);

        if (!meal) {
            return res.status(404).json({ success: false, error: 'Meal not found' });
        }

        await meal.destroy();
        res.json({ success: true, message: 'Meal deleted' });
    } catch (error) {
        console.error('Error deleting meal:', error);
        res.status(500).json({ success: false, error: 'Failed to delete meal' });
    }
});

// Goals endpoints
router.get('/goals', async (req, res) => {
    try {
        const { Goal } = getDatabase(req.user.username);
        const goals = await Goal.findAll({ 
            order: [['completed', 'ASC'], ['deadline', 'ASC']]
        });
        res.json({ success: true, data: goals });
    } catch (error) {
        console.error('Error fetching goals:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch goals' });
    }
});

router.post('/goals', async (req, res) => {
    const { title, description, deadline, completed } = req.body;

    try {
        // Validate input
        if (!title) {
            return res.status(400).json({ success: false, error: 'Title is required' });
        }

        const { Goal } = getDatabase(req.user.username);
        const goal = await Goal.create({ 
            title, 
            description, 
            deadline, 
            completed: completed || false 
        });
        res.status(201).json({ success: true, data: goal });
    } catch (error) {
        console.error('Error creating goal:', error);
        res.status(500).json({ success: false, error: 'Failed to create goal' });
    }
});

router.put('/goals/:id', async (req, res) => {
    const { id } = req.params;
    const { title, description, deadline, completed } = req.body;

    try {
        const { Goal } = getDatabase(req.user.username);
        const goal = await Goal.findByPk(id);

        if (!goal) {
            return res.status(404).json({ success: false, error: 'Goal not found' });
        }

        // Update fields
        if (title !== undefined) goal.title = title;
        if (description !== undefined) goal.description = description;
        if (deadline !== undefined) goal.deadline = deadline;
        if (completed !== undefined) goal.completed = completed;

        await goal.save();
        res.json({ success: true, data: goal });
    } catch (error) {
        console.error('Error updating goal:', error);
        res.status(500).json({ success: false, error: 'Failed to update goal' });
    }
});

router.delete('/goals/:id', async (req, res) => {
    const { id } = req.params;

    try {
        const { Goal } = getDatabase(req.user.username);
        const goal = await Goal.findByPk(id);

        if (!goal) {
            return res.status(404).json({ success: false, error: 'Goal not found' });
        }

        await goal.destroy();
        res.json({ success: true, message: 'Goal deleted' });
    } catch (error) {
        console.error('Error deleting goal:', error);
        res.status(500).json({ success: false, error: 'Failed to delete goal' });
    }
});

// Summary endpoint - get all health data in one call
router.get('/summary', async (req, res) => {
    try {
        const { WeightEntry, Exercise, Meal, Goal } = getDatabase(req.user.username);
        
        const [weight, exercises, meals, goals] = await Promise.all([
            WeightEntry.findAll({ order: [['date', 'DESC']], limit: 30 }),
            Exercise.findAll({ order: [['date', 'DESC']], limit: 30 }),
            Meal.findAll({ order: [['date', 'DESC']], limit: 30 }),
            Goal.findAll({ order: [['completed', 'ASC'], ['deadline', 'ASC']] })
        ]);

        res.json({
            success: true,
            data: {
                weight,
                exercises,
                meals,
                goals
            }
        });
    } catch (error) {
        console.error('Error fetching summary:', error);
        res.status(500).json({ success: false, error: 'Failed to fetch health summary' });
    }
});

module.exports = router;
