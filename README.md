# Octopus Health Tracker

A comprehensive health tracking application for monitoring weight, exercise, food intake, and personal fitness goals.

## Features

- ⚖️ **Weight Tracking** - Log and monitor weight changes over time
- 🏃 **Exercise Tracking** - Record workouts with duration, calories, and distance
- 🍽️ **Food/Meal Tracking** - Log meals with calories and macronutrients (protein, carbs, fats)
- 🎯 **Goal Setting** - Set and track weight, exercise, and calorie goals
- 📊 **Dashboard** - Overview of daily activity and progress
- 🔐 **Password Protected** - Secure multi-user support
- 💾 **SQLite Database** - Per-user data persistence

## Quick Start

### Using Docker Compose (Recommended)

1. Clone the repository:
```bash
git clone https://github.com/anonymous14386/octopus-health.git
cd octopus-health
```

2. Create a `.env` file:
```bash
cp .env.example .env
# Edit .env and set your SESSION_SECRET and APP_PASSWORD
```

3. Run with Docker Compose:
```bash
docker-compose up -d
```

4. Access the app at `http://localhost:3002`

### Manual Setup

1. Install dependencies:
```bash
npm install
```

2. Set environment variables:
```bash
export APP_PASSWORD=your-secure-password
export SESSION_SECRET=your-random-secret-key
```

3. Run the application:
```bash
node index.js
```

## Configuration

Environment variables:
- `APP_PASSWORD` - Password for login (default: "password")
- `SESSION_SECRET` - Secret key for session encryption
- `PORT` - Application port (default: 3000, exposed as 3002 in docker-compose)
- `NODE_ENV` - Environment (development/production)

## Features Detail

### Weight Tracking
- Log daily weight measurements
- Choose between lbs or kg
- Add notes to track context
- View weight history

### Exercise Tracking
- Log various exercise types (running, gym, cycling, etc.)
- Track duration, calories burned, and distance
- Add notes for workout details
- View exercise history

### Meal Tracking
- Log meals by type (breakfast, lunch, dinner, snack)
- Track calories and macronutrients
- Detailed meal descriptions
- View meal history with nutritional info

### Goal Management
- Set weight, exercise, or calorie goals
- Track progress toward targets
- Set deadlines for motivation
- Mark goals as completed

## Docker Deployment

The application is designed to work with Portainer auto-deployment:

1. In Portainer, create a new stack
2. Use the GitHub deployment option
3. Point to: `https://github.com/anonymous14386/octopus-health`
4. Set environment variables in Portainer
5. Deploy!

## Data Persistence

Data is stored in SQLite databases in the `/data` directory. Each user gets their own database file (`username_health.sqlite`). In Docker, this is persisted via the `health_data` volume.

## Tech Stack

- Node.js + Express
- SQLite + Sequelize ORM
- EJS templating
- Express Session for authentication

## Ports

- Default: 3000 (internal)
- Docker exposed: 3002 (external)

## License

MIT
