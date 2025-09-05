const WebSocket = require('ws');
const http = require('http');
const { URL } = require('url');

// Global message store with comprehensive information
const MESSAGES = [];
const MAX_MESSAGES = 100; // Increased from 50 to 100

// WebSocket server instance
let wss;

// Function to initialize and start the WebSocket server
function startWebSocketServer(httpServer) {
    // Create a separate WebSocket server on port 2794
    wss = new WebSocket.Server({ port: 2794 });

    wss.on('connection', (ws, req) => {
        console.log('WebSocket client connected from', req.socket.remoteAddress);

        // Send recent messages to the new client in chronological order (oldest first in the slice)
        const recentMessages = MESSAGES.slice(0, 50).reverse();
        recentMessages.forEach(msg => {
            if (ws.readyState === WebSocket.OPEN) {
                ws.send(msg);
            }
        });

        ws.on('message', message => {
            console.log(`Received message from WebSocket client: ${message}`);
            try {
                const msgStr = message.toString();
                if (msgStr === 'last') {
                    // Send all recent messages again in chronological order (oldest first in the slice)
                    const recentMessages = MESSAGES.slice(0, 50).reverse();
                    recentMessages.forEach(msg => {
                        if (ws.readyState === WebSocket.OPEN) {
                            ws.send(msg);
                        }
                    });
                } else {
                    // Broadcast to all other clients
                    wss.clients.forEach(client => {
                        if (client !== ws && client.readyState === WebSocket.OPEN) {
                            client.send(msgStr);
                        }
                    });
                }
            } catch (err) {
                console.error('Error processing WebSocket message:', err);
            }
        });

        ws.on('close', () => {
            console.log('WebSocket client disconnected');
        });

        ws.on('error', error => {
            console.error('WebSocket error:', error);
        });
    });

    wss.on('listening', () => {
        console.log('WebSocket server started on port 2794');
    });

    return wss;
}

// Function to add a message to the global store and broadcast
function addMessage(message, type = 'info') { // Default type to 'info'
    const messageObject = {
        type: type,
        content: typeof message === 'string' ? message : JSON.stringify(message, null, 2),
        timestamp: new Date().toISOString()
    };

    // Clean message content for WebSocket safety
    messageObject.content = messageObject.content
        .split('')
        .filter((char, index) => {
            const code = char.charCodeAt(0);
            return code >= 32 || code === 10 || code === 13 || code === 9 || (code >= 128 && code <= 55295) || (code >= 57344 && code <= 65535);
        })
        .join('')
        .substring(0, 2000);

    if (messageObject.content.trim().length === 0) {
        return; // Don't send empty messages
    }

    const messageStr = JSON.stringify(messageObject);
    
    MESSAGES.unshift(messageStr);
    if (MESSAGES.length > MAX_MESSAGES) {
        MESSAGES.pop();
    }
    broadcastMessage(messageStr);
}

// Function to get recent messages
function getMessages() {
    return [...MESSAGES]; // Return a copy
}

// Send structured WebSocket message for different types of updates
function sendWebsocketMessage(type, data) {
    const message = {
        type: type,
        data: data,
        timestamp: new Date().toISOString()
    };
    
    try {
        const messageStr = JSON.stringify(message);
        broadcastMessage(messageStr);
    } catch (err) {
        console.error('Error serializing WebSocket message:', err);
    }
}

// Function to broadcast a message to all connected WebSocket clients
function broadcastMessage(message) {
    if (!wss) return;

    // Clean message for WebSocket safety
    const cleanMessage = typeof message === 'string' ? 
        message
            .split('')
            .filter((char, index) => {
                // Allow printable characters, whitespace, and most Unicode characters
                // but exclude control characters (except newlines, tabs, carriage returns)
                const code = char.charCodeAt(0);
                return code >= 32 || code === 10 || code === 13 || code === 9 || (code >= 128 && code <= 55295) || (code >= 57344 && code <= 65535);
            })
            .join('')
            .substring(0, 2000) : // Increase limit to 2000 characters to show more complete information
        JSON.stringify(message, null, 2); // Pretty print JSON with indentation
    
    if (cleanMessage.trim().length === 0) {
        return; // Don't send empty messages
    }

    wss.clients.forEach(client => {
        if (client.readyState === WebSocket.OPEN) {
            try {
                client.send(cleanMessage);
            } catch (err) {
                console.error('Error sending message to client:', err);
            }
        }
    });
}

module.exports = {
    startWebSocketServer,
    addMessage,
    getMessages,
    broadcastMessage,
    sendWebsocketMessage
};