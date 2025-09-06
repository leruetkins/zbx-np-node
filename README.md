# zbx-np-node

Node.js implementation of the zbx-np (Zabbix data relay service) originally written in Rust.

<img width="2337" height="1591" alt="изображение" src="https://github.com/user-attachments/assets/a464585f-55c5-4fdc-a342-44f03db0b30e" />



## Overview

zbx-np-node is a lightweight Zabbix data relay service that enables any system capable of making HTTP requests or publishing MQTT messages to send monitoring data to a Zabbix server via Zabbix trapper items. This bridges legacy or lightweight IoT devices with Zabbix, which traditionally requires specific agents or protocols.

## Features

- Accepts data via HTTP GET/POST requests and forwards it to a specified Zabbix server
- Subscribes to an MQTT topic, periodically collects messages, and relays them to Zabbix
- Offers a WebSocket-based web console (`/console`) to monitor incoming data in real time
- Supports basic authentication for HTTP endpoints
- Configurable via a JSON configuration file
- User and token management for API access
- Real-time status updates via WebSocket
- Comprehensive logging and error handling

## System Requirements

- Node.js 14.x or higher
- npm (Node Package Manager)

## Installation

1. Clone the repository:
   ```bash
   git clone <repository-url>
   cd zbx-np-node
   ```

2. Install dependencies:
   ```bash
   npm install
   ```

3. Create a configuration file (see Configuration section below)

4. Start the server:
   ```bash
   npm start
   ```

## Configuration

The service is configured via a `config.json` file in the project root directory. If this file doesn't exist, a default configuration will be created automatically.

Example configuration:
```json
{
  "settings": {
    "http": {
      "port": 7000,
      "login": "admin",
      "password": "admin"
    },
    "mqtt": {
      "enabled": true,
      "url": "mqtts://address.s2.eu.hivemq.cloud:8883",
      "id": "zbx-np-node",
      "login": "your_login",
      "password": "your_password",
      "period": 10,
      "topic": "/zabbix/test"
    }
  },
  "users": [
    {
      "id": 1,
      "username": "admin",
      "password": "admin",
      "created_at": "2023-01-01T00:00:00.000Z"
    }
  ],
  "tokens": []
}
```

### Configuration Fields

- `settings.http.port`: Port for the HTTP server (default: 7000)
- `settings.http.login`: Username for HTTP basic authentication
- `settings.http.password`: Password for HTTP basic authentication
- `settings.mqtt.enabled`: Enable/disable MQTT client
- `settings.mqtt.url`: MQTT broker URL (supports mqtt:// and mqtts://)
- `settings.mqtt.id`: Client ID for MQTT connection
- `settings.mqtt.login`: Username for MQTT authentication
- `settings.mqtt.password`: Password for MQTT authentication
- `settings.mqtt.period`: Polling period in seconds
- `settings.mqtt.topic`: MQTT topic to subscribe to

## API Endpoints

### Data Ingestion

- `GET /zabbix?server_ip=<IP>&server_port=<PORT>&item_host_name=<HOSTNAME>&<ITEM_KEY_1>=<VALUE_1>&...` - Send data to Zabbix via URL parameters (requires authentication)
- `POST /zabbix` - Send data to Zabbix via JSON body (requires authentication)

**GET Request Example:**
```bash
curl "http://localhost:7000/zabbix?server_ip=192.168.0.163&server_port=10051&item_host_name=test&voltage=54.4&temperature=25.1"
```
**Parameters for GET Request:**
- `server_ip`: IP address of the Zabbix server.
- `server_port`: Port of the Zabbix server (e.g., 10051).
- `item_host_name`: Hostname as configured in Zabbix.
- Any other `KEY=VALUE` pairs will be treated as Zabbix item keys and their respective values. Only numeric values are supported for item values.

**POST Request Data Format:**
```json
{
  "zabbix_server_ip": "zabbix-server-ip",
  "zabbix_server_port": 10051,
  "item_host_name": "host-name",
  "item": [
    {
      "key": "item.key",
      "value": 123
    }
  ]
}
```

### Authentication

- `POST /api/auth/login` - Login with username/password
- `POST /api/auth/logout` - Logout

### Configuration Management

- `GET /api/config` - Get current configuration
- `PUT /api/config` - Update configuration
- `POST /api/config/test` - Test configuration

### User Management

- `GET /api/users` - List users
- `POST /api/users` - Create user
- `DELETE /api/users/:id` - Delete user

### Token Management

- `GET /api/tokens` - List tokens
- `POST /api/tokens` - Create token
- `DELETE /api/tokens/:id` - Delete token

### Monitoring

- `GET /api/stats` - Get statistics
- `GET /api/mqtt/status` - Get MQTT status
- `GET /api/logs` - Get recent logs

## WebSocket Interface

The service provides a WebSocket interface on port 2794 for real-time monitoring:

- Connect to `ws://localhost:2794`
- Send `last` to receive recent messages
- Receive real-time updates for MQTT status and other events

## Web Console

A web-based console is available at `http://localhost:7000/console` for monitoring the service in real-time.

## License

This project is licensed under the MIT License.
