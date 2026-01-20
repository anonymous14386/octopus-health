const express = require('express');
const router = express.Router();

// Import route modules
const authRouter = require('./routes/auth');
const healthRouter = require('./routes/health');

// Mount routes
router.use('/auth', authRouter);
router.use('/health', healthRouter);

module.exports = router;
