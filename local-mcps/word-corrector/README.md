# Pycorrector MCP Server (Node.js)

A simple MCP (Model Context Protocol) server built with fastmcp that provides Chinese text error correction.

## Features

- `get_correct`: Detect and correct Chinese text typos, supporting phonetic and shape-similar error detection.

## Installation

1. Navigate to the project directory:
   ```bash
   cd pycorrector-nodejs
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

- Calls a remote pycorrector API endpoint for text correction.
- Returns original text, corrected text, and a list of detected errors including wrong/right pairs.

## Troubleshooting

- Ensure Node.js is installed (version 18+ recommended).
- Ensure `PB_PYCORRECTOR_API_URL` and `PB_PYCORRECTOR_AUTH_KEY` environment variables are set.
- If the server fails to start, verify dependencies are installed correctly.