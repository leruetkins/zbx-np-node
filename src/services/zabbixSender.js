const net = require('net');
const { Buffer } = require('buffer');

const ZABBIX_MAX_LEN = 300;
const ZABBIX_TIMEOUT = 1000; // milliseconds

// Import the addMessage function for global message logging
const { addMessage } = require('./websocketServer');

class ZabbixSender {
    constructor(zabbixServerAddr, zabbixItemHostName) {
        this.zabbixServerAddr = zabbixServerAddr; // e.g., '127.0.0.1:10051'
        this.zabbixItemHostName = zabbixItemHostName;
        this.zabbixItemList = []; // Array of { key: string, value: string }
        this.zabbixPacket = Buffer.alloc(ZABBIX_MAX_LEN);
    }

    clearItem() {
        this.zabbixItemList = [];
    }

    addItem(key, value) {
        this.zabbixItemList.push({ key, value });
    }

    createZabbixPacket() {
        const data = this.zabbixItemList.map(item => {
            return `{"host":"${this.zabbixItemHostName}","key":"${item.key}","value":"${item.value}"}`;
        }).join(',');

        const json = `{"request":"sender data","data":[${data}]}`;
        const jsonLen = Buffer.byteLength(json, 'utf8');

        let remLen = jsonLen;
        for (let i = 0; i < 8; i++) {
            this.zabbixPacket[5 + i] = remLen % 256;
            remLen = Math.floor(remLen / 256);
        }

        this.zabbixPacket[0] = 'Z'.charCodeAt(0);
        this.zabbixPacket[1] = 'B'.charCodeAt(0);
        this.zabbixPacket[2] = 'X'.charCodeAt(0);
        this.zabbixPacket[3] = 'D'.charCodeAt(0);
        this.zabbixPacket[4] = 0x01;

        const jsonBytes = Buffer.from(json, 'utf8');
        jsonBytes.copy(this.zabbixPacket, 13);

        const packetLen = 13 + jsonLen;

        const requestMessage = `Request JSON: ${json}`;
        console.log(requestMessage);
        addMessage(requestMessage, 'zabbix-request'); // Log to global message system
        console.log(`Zabbix: Sending ${this.zabbixItemList.length} data items to server`);
        addMessage(`Zabbix: Sending ${this.zabbixItemList.length} data items to server`, 'zabbix-info'); // Log to global message system

        return packetLen;
    }

    send() {
        return new Promise((resolve, reject) => {
            const packetLen = this.createZabbixPacket();
            
            // Validate server address
            if (!this.zabbixServerAddr.address || !this.zabbixServerAddr.port) {
                const errorMsg = 'Invalid Zabbix server address or port';
                return reject(new Error(errorMsg));
            }
            
            const client = new net.Socket();
            let responseData = '';

            const timeout = setTimeout(() => {
                client.destroy();
                const errorMsg = 'Zabbix connection timed out';
                reject(new Error(errorMsg));
            }, ZABBIX_TIMEOUT);

            client.connect(this.zabbixServerAddr.port, this.zabbixServerAddr.address, () => {
                clearTimeout(timeout);
                client.write(this.zabbixPacket.slice(0, packetLen));
            });

            client.on('data', (data) => {
                responseData += data.toString();
            });

            client.on('end', () => {
                clearTimeout(timeout);
                console.log(`Zabbix Result = ${responseData}`);
                addMessage(`Zabbix Result: ${responseData}`, 'zabbix-result'); // Log to global message system
                resolve(responseData);
            });

            client.on('error', (err) => {
                clearTimeout(timeout);
                console.error(`Zabbix send error: ${err.message}`);
                reject(err);
            });

            client.on('close', () => {
                clearTimeout(timeout);
            });
        });
    }
}

// This function is from the Rust code, for decoding Zabbix responses
function decodeUnicodeEscapeSequences(input) {
    const prefix = "ZBXD\u0001Z\u0000\u0000\u0000\u0000\u0000\u0000\u0000";
    let strippedInput = input.startsWith(prefix) ? input.substring(prefix.length) : input;

    // The Rust code's decode_unicode_escape_sequences seems to be specifically for
    // handling Zabbix protocol header and then potentially unicode escapes.
    // Node.js's JSON.parse handles unicode escapes automatically.
    // So, for the actual JSON part, we can just parse it.
    // The Rust code also had a manual unicode escape decoder.
    // For simplicity, we'll assume the Zabbix response after stripping the header
    // is valid JSON or plain text. If it's JSON, JSON.parse will handle escapes.
    // If it's plain text with literal \uXXXX, we might need a more robust decoder.
    // Given the Rust code's `decode_unicode_escape_sequences` function, it seems to be
    // handling the Zabbix header and then potentially some non-standard unicode escapes.
    // For now, I'll just strip the header and return the rest.
    // If the Zabbix response is JSON, `JSON.parse` will handle standard unicode escapes.

    // Re-implementing the Rust logic for decoding unicode escapes if they are not standard JSON escapes.
    // This is a simplified version and might need adjustments based on actual Zabbix responses.
    let decoded = '';
    let i = 0;
    while (i < strippedInput.length) {
        if (strippedInput[i] === '\\' && strippedInput[i+1] === 'u') {
            const hex = strippedInput.substring(i + 2, i + 6);
            if (/^[0-9a-fA-F]{4}$/.test(hex)) {
                decoded += String.fromCharCode(parseInt(hex, 16));
                i += 6;
            } else {
                decoded += strippedInput[i];
                i++;
            }
        } else {
            decoded += strippedInput[i];
            i++;
        }
    }
    return decoded;
}


module.exports = {
    ZabbixSender,
    decodeUnicodeEscapeSequences
};