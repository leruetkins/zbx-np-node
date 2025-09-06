const fs = require('fs').promises;
const path = require('path');
const { app } = require('electron'); // Import 'app' module

let _configPath; // Private variable to store config path after initialization
let _configDirectory; // Private variable to store config directory after initialization
let config = {};

async function createDefaultConfig() {
    const defaultConfig = {
        settings: {
            http: {
                port: 7000,
                login: "admin",
                password: "admin"
            },
            mqtt: {
                enabled: false,
                url: "",
                id: "",
                login: "",
                password: "",
                period: 10,
                topic: ""
            }
        },
        users: [
            {
                id: 1,
                username: "admin",
                password: "admin",
                created_at: new Date().toISOString()
            }
        ],
        tokens: []
    };
    
    try {
        // Ensure the directory exists
        await fs.mkdir(_configDirectory, { recursive: true });
        await fs.writeFile(_configPath, JSON.stringify(defaultConfig, null, 4));
        console.log(`Created default config.json in ${_configPath}`);
        return defaultConfig;
    } catch (error) {
        console.error('Failed to create default config:', error);
        throw error;
    }
}

async function loadOrCreateConfig() {
    if (process.versions.electron) {
        await app.whenReady(); // Ensure app is ready before getting path
        _configDirectory = app.getPath('userData');
    } else {
        _configDirectory = process.cwd();
    }
    _configPath = path.join(_configDirectory, 'config.json');

    try {
        const configContent = await fs.readFile(_configPath, 'utf-8');
        config = JSON.parse(configContent);
        console.log("Configuration loaded.");
        
        // Ensure all required fields exist
        if (!config.settings) config.settings = {};
        if (!config.settings.http) config.settings.http = { port: 7000, login: "admin", password: "admin" };
        if (!config.settings.mqtt) config.settings.mqtt = { enabled: false, url: "", id: "", login: "", password: "", period: 10, topic: "" };
        if (!config.users) config.users = [{ id: 1, username: "admin", password: "admin", created_at: new Date().toISOString() }];
        if (!config.tokens) config.tokens = [];
        
        return config;
    } catch (error) {
        if (error.code === 'ENOENT') {
            console.log("Config file not found, creating default config.json...");
            config = await createDefaultConfig();
            return config;
        } else if (error instanceof SyntaxError) {
            console.error(`Invalid JSON format in ${projectRootConfigPath}:`, error.message);
            console.error("Please fix the JSON syntax or delete the file to create a new default config.");
            process.exit(1);
        } else {
            console.error(`Error reading config file ${projectRootConfigPath}:`, error);
            process.exit(1);
        }
    }
}

// Helper to get nested properties from the loaded config
function get(path, defaultValue) {
    const keys = path.split('.');
    let result = config;
    for (const key of keys) {
        if (result === undefined || result === null) return defaultValue;
        result = result[key];
    }
    return result === undefined ? defaultValue : result;
}

// Helper to set nested properties in the loaded config object
function set(path, value) {
    const keys = path.split('.');
    let current = config;
    for (let i = 0; i < keys.length - 1; i++) {
        const key = keys[i];
        if (current[key] === undefined || typeof current[key] !== 'object') {
            current[key] = {};
        }
        current = current[key];
    }
    current[keys[keys.length - 1]] = value;
}

async function saveConfig() {
    try {
        // Ensure the directory exists
        await fs.mkdir(_configDirectory, { recursive: true });
        await fs.writeFile(_configPath, JSON.stringify(config, null, 4));
        console.log("Configuration saved successfully.");
    } catch (error) {
        console.error(`Error saving config file ${projectRootConfigPath}:`, error);
        throw error;
    }
}

module.exports = {
    loadOrCreateConfig,
    saveConfig,
    get,
    set,
    getFullConfig: () => config
};