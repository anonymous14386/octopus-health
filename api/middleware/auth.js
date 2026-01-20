const jwt = require('jsonwebtoken');

const JWT_SECRET = process.env.JWT_SECRET || 'default-jwt-secret-change-me';

const authenticateToken = (req, res, next) => {
    const authHeader = req.headers.authorization;
    
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
        return res.status(401).json({ success: false, error: 'Missing or invalid authorization header' });
    }
    
    const token = authHeader.substring(7); // Remove 'Bearer ' prefix
    
    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = { username: decoded.username };
        next();
    } catch (error) {
        return res.status(401).json({ success: false, error: 'Invalid or expired token' });
    }
};

module.exports = { authenticateToken, JWT_SECRET };
