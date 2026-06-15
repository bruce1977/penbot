@echo off
set CONFIG_PATH=configs\%~1-config.json
npx dotenv-cli -e .env -- opencode run "/cmd-wechat-mp-articles %CONFIG_PATH%"
