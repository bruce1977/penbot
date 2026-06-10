# Weather MCP Server (Node.js)

A simple MCP (Model Context Protocol) server built with fastmcp that provides weather information.

## Features

- `get_current_weather`: Get the current weather for your location (based on IP).
- `get_weather_by_city`: Get the current weather for a specified city.

## Installation

1. Navigate to the project directory:
   ```bash
   cd weather-mcp-nodejs
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

## Usage

Start the server:
```bash
npm start
```

The server will start and listen for MCP requests.

## API Details

- Uses wttr.in for weather data (free, no API key required).
- Returns weather information including temperature, description, humidity, and wind speed.

## Troubleshooting

- Ensure Node.js is installed (version 14+ recommended).
- Check internet connection for API calls.
- If the server fails to start, verify dependencies are installed correctly.