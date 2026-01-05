const { Sequelize, DataTypes } = require('sequelize');
const path = require('path');

const getDatabase = (username) => {
    const sequelize = new Sequelize({
        dialect: 'sqlite',
        storage: path.join(__dirname, 'data', `${username}_health.sqlite`),
        logging: false
    });

    // Weight tracking
    const WeightEntry = sequelize.define('WeightEntry', {
        date: {
            type: DataTypes.DATEONLY,
            allowNull: false,
            defaultValue: DataTypes.NOW
        },
        weight: {
            type: DataTypes.FLOAT,
            allowNull: false
        },
        unit: {
            type: DataTypes.ENUM('kg', 'lbs'),
            allowNull: false,
            defaultValue: 'lbs'
        },
        notes: {
            type: DataTypes.TEXT,
            allowNull: true
        }
    });

    // Exercise tracking
    const Exercise = sequelize.define('Exercise', {
        date: {
            type: DataTypes.DATEONLY,
            allowNull: false,
            defaultValue: DataTypes.NOW
        },
        type: {
            type: DataTypes.STRING,
            allowNull: false
        },
        duration: {
            type: DataTypes.INTEGER, // minutes
            allowNull: false
        },
        calories: {
            type: DataTypes.INTEGER,
            allowNull: true
        },
        distance: {
            type: DataTypes.FLOAT, // miles or km
            allowNull: true
        },
        notes: {
            type: DataTypes.TEXT,
            allowNull: true
        }
    });

    // Food/Meal tracking
    const Meal = sequelize.define('Meal', {
        date: {
            type: DataTypes.DATEONLY,
            allowNull: false,
            defaultValue: DataTypes.NOW
        },
        time: {
            type: DataTypes.TIME,
            allowNull: false
        },
        mealType: {
            type: DataTypes.ENUM('breakfast', 'lunch', 'dinner', 'snack'),
            allowNull: false
        },
        description: {
            type: DataTypes.TEXT,
            allowNull: false
        },
        calories: {
            type: DataTypes.INTEGER,
            allowNull: true
        },
        protein: {
            type: DataTypes.FLOAT, // grams
            allowNull: true
        },
        carbs: {
            type: DataTypes.FLOAT, // grams
            allowNull: true
        },
        fats: {
            type: DataTypes.FLOAT, // grams
            allowNull: true
        },
        notes: {
            type: DataTypes.TEXT,
            allowNull: true
        }
    });

    // Goals tracking
    const Goal = sequelize.define('Goal', {
        type: {
            type: DataTypes.ENUM('weight', 'exercise', 'calories'),
            allowNull: false
        },
        targetValue: {
            type: DataTypes.FLOAT,
            allowNull: false
        },
        currentValue: {
            type: DataTypes.FLOAT,
            allowNull: true
        },
        deadline: {
            type: DataTypes.DATEONLY,
            allowNull: true
        },
        description: {
            type: DataTypes.TEXT,
            allowNull: true
        },
        completed: {
            type: DataTypes.BOOLEAN,
            defaultValue: false
        }
    });

    return {
        sequelize,
        WeightEntry,
        Exercise,
        Meal,
        Goal
    };
};

module.exports = getDatabase;
