const express = require("express");
const cors = require("cors");
const fs = require("fs");
const { exec, spawn } = require("child_process");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const http = require("http");
const pty = require("node-pty");
const os = require("os");
const securityScripts = require('./docker-security-scripts');

const app = express();
const terminalPort = 3001; 

app.use(express.json());
app.use(cors());

const clients = new Map();
const terminals = new Map();
const pendingCleanups = new Map();
const WORKSPACE_BASE = "./docker_workspaces";
const CLEANUP_DELAY = 5 * 60 * 1000; 

if (!fs.existsSync(WORKSPACE_BASE)) {
    fs.mkdirSync(WORKSPACE_BASE, { recursive: true });
}

const createContainer = (clientId, workspacePath) => {
    return new Promise((resolve, reject) => {
        const containerName = `rust-workspace-${clientId.toLowerCase()}`;

        exec(`docker ps -a --filter name=${containerName} --format "{{.Names}}"`, (error, stdout) => {
            if (error) return reject(error);
            
            if (stdout.trim() === containerName) {
                exec(`docker container inspect -f '{{.State.Running}}' ${containerName}`, (err, runningOutput) => {
                    if (err) return reject(err);
                    
                    if (runningOutput.trim() === 'true') {
                        console.log(`Container ${containerName} already exists and is running`);
                        checkContainerReadiness(containerName).then(() => {
                            resolve(containerName);
                        }).catch(err => {
                            reject(err);
                        });
                    } else {
                        console.log(`Container ${containerName} exists but is not running. Starting...`);
                        exec(`docker start ${containerName}`, (startErr) => {
                            if (startErr) return reject(startErr);
                            checkContainerReadiness(containerName).then(() => {
                                resolve(containerName);
                            }).catch(err => {
                                reject(err);
                            });
                        });
                    }
                });
                return;
            }

            securityScripts.createSecureDockerfile(workspacePath);

            exec(`docker build -t ${containerName} ${workspacePath} && docker run -d --name ${containerName} --rm ${containerName}`,
                (error, stdout, stderr) => {
                    if (error) return reject(error);
                    console.log(`Container ${containerName} created, waiting for packages to be installed...`);
                    
                    checkContainerReadiness(containerName).then(() => {
                        resolve(containerName);
                    }).catch(err => {
                        reject(err);
                    });
                }
            );
        });
    });
};

const checkContainerReadiness = (containerName) => {
    return new Promise((resolve, reject) => {
        const MAX_RETRIES = 30;
        const RETRY_INTERVAL = 2000;
        let retries = 0;
        
        const checkReady = () => {
            exec(`docker exec ${containerName} bash -c "command -v rustc && command -v cargo && cargo --version && rustc --version"`, 
                (error, stdout, stderr) => {
                    if (error) {
                        if (retries < MAX_RETRIES) {
                            retries++;
                            console.log(`Container ${containerName} not ready yet. Retry ${retries}/${MAX_RETRIES}...`);
                            setTimeout(checkReady, RETRY_INTERVAL);
                        } else {
                            reject(new Error("Container setup timed out. Dependencies not installed properly."));
                        }
                        return;
                    }
                 
                    exec(`docker exec ${containerName} bash -c "ps aux | grep -v grep | grep -q 'rust' || exit 0"`, 
                        (err, psOutput) => {
                            console.log(`Container ${containerName} is ready with all dependencies installed.`);
                            resolve();
                        }
                    );
                }
            );
        };
        
        checkReady();
    });
};

// Add this endpoint to your Express app
app.post("/api/run-command", async (req, res) => {
    const { clientId, command } = req.body;

    if (!clientId) {
        return res.status(400).json({ error: "Client ID is required" });
    }

    if (!command) {
        return res.status(400).json({ error: "Command is required" });
    }

    // Cancel any cleanup for this client
    cancelCleanup(clientId);

    // Check if client exists
    if (!clients.has(clientId)) {
        return res.status(404).json({ error: "Client workspace not found" });
    }

    const client = clients.get(clientId);
    const containerName = client.containerName;

    try {
        // Check container status
        const containerStatus = await getContainerStatus(containerName);
        if (!containerStatus.ready) {
            return res.status(503).json({ 
                error: "Container is still initializing", 
                status: "container_initializing" 
            });
        }

        // Execute the command
        const commandProcess = spawn("docker", ["exec", containerName, "bash", "-c", `cd /usr/src/app && ${command}`], { shell: false });
        
        let stdout = "";
        let stderr = "";

        commandProcess.stdout.on("data", (data) => {
            stdout += data.toString();
        });

        commandProcess.stderr.on("data", (data) => {
            stderr += data.toString();
        });

        commandProcess.on("close", (code) => {
            res.json({
                success: code === 0,
                stdout,
                stderr,
                exitCode: code
            });
        });

        // Set a timeout in case the command hangs
        setTimeout(() => {
            if (!res.headersSent) {
                commandProcess.kill();
                res.status(504).json({ error: "Command execution timed out" });
            }
        }, 30000); // 30 second timeout

    } catch (error) {
        console.error("Error running command:", error);
        res.status(500).json({ error: "Failed to execute command", details: error.message });
    }
});

const runCommandInContainer = (containerName, command) => {
    return spawn("docker", ["exec", containerName, "bash", "-c", command], { shell: false });
};

const copyToContainer = (containerName, source, dest) => {
    return new Promise((resolve, reject) => {
        exec(`docker cp ${source} ${containerName}:${dest}`, (error) => {
            if (error) return reject(error);
            resolve();
        });
    });
};

const removeContainer = (containerName) => {
    return new Promise((resolve, reject) => {
        exec(`docker stop ${containerName} || true`, (error) => {
            if (error) return reject(error);
            resolve();
        });
    });
};

const scheduleCleanup = (clientId, workspacePath) => {
    cancelCleanup(clientId);
    
    console.log(`Scheduling cleanup for client ${clientId} in 5 minutes`);
    
    const timerId = setTimeout(async () => {
        console.log(`Performing cleanup for client ${clientId} after 5 minutes of inactivity`);
        
        try {
            if (clients.has(clientId)) {
                const client = clients.get(clientId);
                
                if (client.process) {
                    client.process.kill("SIGTERM");
                    client.process = null;
                }
                
                await removeContainer(`rust-workspace-${clientId.toLowerCase()}`);
                fs.rmSync(workspacePath, { recursive: true, force: true });
                clients.delete(clientId);
                
                console.log(`Cleanup completed for client ${clientId}`);
            }
        } catch (error) {
            console.error(`Error during cleanup for client ${clientId}:`, error);
        }
        
        pendingCleanups.delete(clientId);
    }, CLEANUP_DELAY);
    
    pendingCleanups.set(clientId, timerId);
};

const cancelCleanup = (clientId) => {
    if (pendingCleanups.has(clientId)) {
        clearTimeout(pendingCleanups.get(clientId));
        pendingCleanups.delete(clientId);
        console.log(`Canceled cleanup for client ${clientId}`);
    }
};

const server = http.createServer(app);

const terminalWss = new WebSocket.Server({ server });

server.listen(terminalPort, () => console.log(`Terminal WebSocket server running on ws://localhost:${terminalPort}`));

// Get container status
const getContainerStatus = (containerName) => {
    return new Promise((resolve, reject) => {
        exec(`docker exec ${containerName} bash -c "rustc --version && cargo --version && echo 'Container status: READY'"`, 
            (error, stdout, stderr) => {
                if (error) {
                    resolve({
                        ready: false,
                        status: "Container exists but dependencies are not fully installed",
                        details: stderr
                    });
                    return;
                }
                
                resolve({
                    ready: true,
                    status: "Ready",
                    details: stdout
                });
            }
        );
    });
};
terminalWss.on("connection", async (ws) => {
    const terminalId = uuidv4();
    let containerName = null;
    let clientId = null;
    let ptyProcess = null;
    let clientWorkspace = null;
    
    ws.on("message", async (message) => {
        try {
            const data = JSON.parse(message);
            
            if (data.type === "connect") {
                clientId = data.uuid || null;
                
                if (clientId) {
                    clientWorkspace = `${WORKSPACE_BASE}/${clientId}`;
                    containerName = `rust-workspace-${clientId.toLowerCase()}`;
                    
                    cancelCleanup(clientId);
                    
                    if (!fs.existsSync(clientWorkspace)) {
                        fs.mkdirSync(clientWorkspace, { recursive: true });
                        
                        if (!fs.existsSync(`${clientWorkspace}/src`)) {
                            fs.mkdirSync(`${clientWorkspace}/src`, { recursive: true });
                        }
                    }
                    
                    try {
                        const existingClient = clients.get(clientId);
                        let isExistingContainer = false;
                        
                        if (existingClient) {
                            containerName = existingClient.containerName;
                            clientWorkspace = existingClient.workspace;
                            isExistingContainer = true;
                            
                            // Check if existing container is ready
                            const containerStatus = await getContainerStatus(containerName);
                            
                            if (!containerStatus.ready) {
                                ws.send(JSON.stringify({
                                    type: 'status',
                                    status: 'container_initializing',
                                    message: 'Container exists but dependencies are still being installed...'
                                }));
                                
                                try {
                                    await checkContainerReadiness(containerName);
                                    ws.send(JSON.stringify({
                                        type: 'status',
                                        status: 'container_ready',
                                        message: 'Container is now ready with all dependencies installed'
                                    }));
                                } catch (err) {
                                    ws.send(JSON.stringify({
                                        type: 'error',
                                        message: 'Failed to initialize container',
                                        details: err.message
                                    }));
                                    return;
                                }
                            } else {
                                ws.send(JSON.stringify({
                                    type: 'status',
                                    status: 'container_ready',
                                    message: 'Container is ready with all dependencies installed'
                                }));
                            }
                        } else {
                            ws.send(JSON.stringify({
                                type: 'status',
                                status: 'container_creating',
                                message: 'Creating new Docker container and installing dependencies...'
                            }));
                            
                            await createContainer(clientId, clientWorkspace);
                            
                            ws.send(JSON.stringify({
                                type: 'status',
                                status: 'container_ready',
                                message: 'Container is ready with all dependencies installed'
                            }));
                            
                            // Ensure the container starts in the Rust project directory
                            await runCommandInContainer(containerName, "cd /usr/src/app");
                            
                            clients.set(clientId, { 
                                containerName, 
                                workspace: clientWorkspace, 
                                connections: new Set(),
                                process: null 
                            });
                        }
                        
                        const client = clients.get(clientId);
                        client.connections.add(ws);
                        
                        const shell = process.platform === 'win32' ? 'powershell.exe' : 'bash';
                        
                        ptyProcess = pty.spawn(shell, ['-c', `docker exec -it ${containerName} zsh -c "cd /usr/src/app && zsh"`], {
                            name: 'xterm-color',
                            cols: data.cols || 80,
                            rows: data.rows || 24,
                            cwd: os.homedir(),
                            env: process.env
                        });
                        
                        terminals.set(terminalId, { 
                            ws, 
                            ptyProcess, 
                            containerName,
                            clientId 
                        });
                    
                        ptyProcess.onData((data) => {
                            if (ws.readyState === WebSocket.OPEN) {
                                ws.send(JSON.stringify({ type: 'output', data }));
                            }
                        });
                        
                        ws.send(JSON.stringify({ 
                            type: 'connected', 
                            message: `Terminal connected successfully to ${isExistingContainer ? 'existing' : 'new'} Docker container`,
                            terminalId,
                            clientId,
                            dockerCreated: true,
                            isExistingContainer
                        }));
                    } catch (err) {
                        ws.send(JSON.stringify({ 
                            type: 'error', 
                            message: 'Failed to create or connect to workspace', 
                            details: err.message 
                        }));
                        return;
                    }
                } else {
                    ws.send(JSON.stringify({ 
                        type: 'connected', 
                        message: 'Terminal connected successfully, no Docker container created',
                        terminalId,
                        dockerCreated: false
                    }));
                }
            } else if (data.type === 'input') {
                if (clientId) {
                    cancelCleanup(clientId);
                }
                
                if (ptyProcess) {
                    const input = data.data;
                    ptyProcess.write(input);
                } else {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'No terminal process available, Docker container was not created'
                    }));
                }
            } else if (data.type === 'resize') {
                if (ptyProcess) {
                    ptyProcess.resize(data.cols, data.rows);
                }
            } else if (data.type === 'checkContainerStatus') {
                if (clientId && containerName) {
                    try {
                        const containerStatus = await getContainerStatus(containerName);
                        ws.send(JSON.stringify({
                            type: 'status',
                            status: containerStatus.ready ? 'container_ready' : 'container_initializing',
                            message: containerStatus.status,
                            details: containerStatus.details
                        }));
                    } catch (err) {
                        ws.send(JSON.stringify({
                            type: 'error',
                            message: 'Failed to check container status',
                            details: err.message
                        }));
                    }
                } else {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'No container available to check status'
                    }));
                }
            } else if (data.type === 'executeCommand') {
                if (clientId) {
                    cancelCleanup(clientId);
                }
                
                if (!clientId || !clients.has(clientId)) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Invalid client ID, Docker container was not created, or session expired'
                    }));
                    return;
                }
                
                const client = clients.get(clientId);
                
                const containerStatus = await getContainerStatus(client.containerName);
                if (!containerStatus.ready) {
                    ws.send(JSON.stringify({
                        type: 'status',
                        status: 'container_initializing',
                        message: 'Container is still initializing, please wait...'
                    }));
                    return;
                }
                
                const { cargoToml, mainRs, command } = data;
                
                fs.writeFileSync(`${client.workspace}/Cargo.toml`, cargoToml);
                fs.writeFileSync(`${client.workspace}/src/main.rs`, mainRs);

                await copyToContainer(client.containerName, `${client.workspace}/Cargo.toml`, "/usr/src/app/Cargo.toml");
                await copyToContainer(client.containerName, `${client.workspace}/src/main.rs`, "/usr/src/app/src/main.rs");

                // Run the command in the pty process if it exists
                if (ptyProcess) {
                    // First clear any existing process
                    if (client.process) {
                        client.process.kill("SIGTERM");
                        client.process = null;
                    }
                    
                    // Send the command to the terminal
                    const cargoCommand = command || 'run';
                    ptyProcess.write(`cargo ${cargoCommand}\r`);
                    
                    // Set buttonMode to 'done' after some time
                    setTimeout(() => {
                        client.connections.forEach(connection => {
                            if (connection.readyState === WebSocket.OPEN) {
                                connection.send(JSON.stringify({ 
                                    type: 'runStatus', 
                                    status: 'Command sent to terminal' 
                                }));
                            }
                        });
                    }, 500);
                } else {
                    // Fallback to the separate process approach
                    if (client.process) {
                        client.process.kill("SIGTERM");
                        client.process = null;
                    }

                    const cargoCommand = command || 'run';
                    client.process = runCommandInContainer(client.containerName, `cd /usr/src/app && cargo ${cargoCommand}`);
                    
                    client.process.stdout.on("data", (data) => {
                        const output = data.toString();
                        client.connections.forEach(connection => {
                            if (connection.readyState === WebSocket.OPEN) {
                                connection.send(JSON.stringify({ type: 'runOutput', output }));
                            }
                        });
                    });
                    
                    client.process.stderr.on("data", (data) => {
                        const error = data.toString();
                        client.connections.forEach(connection => {
                            if (connection.readyState === WebSocket.OPEN) {
                                connection.send(JSON.stringify({ type: 'runError', error }));
                            }
                        });
                    });

                    client.process.on("close", (code) => {
                        client.connections.forEach(connection => {
                            if (connection.readyState === WebSocket.OPEN) {
                                connection.send(JSON.stringify({ type: 'runStatus', status: `Exited with code ${code}` }));
                            }
                        });
                        client.process = null;
                    });
                }
            } else if (data.type === 'stopCommand') {
                if (clientId && clients.has(clientId)) {
                    const client = clients.get(clientId);
                    
                    // If running in the terminal, send CTRL+C
                    if (ptyProcess) {
                        ptyProcess.write('\u0003'); // CTRL+C
                        
                        client.connections.forEach(connection => {
                            if (connection.readyState === WebSocket.OPEN) {
                                connection.send(JSON.stringify({ type: 'runStatus', status: 'Process stopped' }));
                            }
                        });
                    } else if (client.process) {
                        // Otherwise kill the separate process
                        client.process.kill("SIGTERM");
                        client.process = null;
                        
                        client.connections.forEach(connection => {
                            if (connection.readyState === WebSocket.OPEN) {
                                connection.send(JSON.stringify({ type: 'runStatus', status: 'Process stopped' }));
                            }
                        });
                    }
                }
            } else if (data.type === 'updateFile') {
                if (clientId) {
                    cancelCleanup(clientId);
                }
                
                if (!clientId || !clients.has(clientId)) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Invalid client ID, Docker container was not created, or session expired'
                    }));
                    return;
                }
                
                const client = clients.get(clientId);
                
                try {
                    // Check if the container is ready before proceeding
                    const containerStatus = await getContainerStatus(client.containerName);
                    if (!containerStatus.ready) {
                        ws.send(JSON.stringify({
                            type: 'status',
                            status: 'container_initializing',
                            message: 'Container is still initializing, file update queued...'
                        }));
                    }
                    
                    // Handle the file updates
                    if (data.mainRs !== undefined) {
                        fs.writeFileSync(`${client.workspace}/src/main.rs`, data.mainRs);
                        await copyToContainer(client.containerName, `${client.workspace}/src/main.rs`, "/usr/src/app/src/main.rs");
                        ws.send(JSON.stringify({
                            type: 'fileUpdated',
                            file: 'src/main.rs',
                            status: 'success'
                        }));
                    }
                    
                    if (data.cargoToml !== undefined) {
                        fs.writeFileSync(`${client.workspace}/Cargo.toml`, data.cargoToml);
                        await copyToContainer(client.containerName, `${client.workspace}/Cargo.toml`, "/usr/src/app/Cargo.toml");
                        ws.send(JSON.stringify({
                            type: 'fileUpdated',
                            file: 'Cargo.toml',
                            status: 'success'
                        }));
                    }
            
                    // Notify all connected clients about file updates
                    client.connections.forEach(connection => {
                        if (connection !== ws && connection.readyState === WebSocket.OPEN) {
                            if (data.mainRs !== undefined) {
                                connection.send(JSON.stringify({
                                    type: 'fileChanged',
                                    file: 'src/main.rs',
                                    content: data.mainRs
                                }));
                            }
                            if (data.cargoToml !== undefined) {
                                connection.send(JSON.stringify({
                                    type: 'fileChanged',
                                    file: 'Cargo.toml',
                                    content: data.cargoToml
                                }));
                            }
                        }
                    });
                    
                } catch (error) {
                    ws.send(JSON.stringify({
                        type: 'error',
                        message: 'Failed to update file',
                        details: error.message
                    }));
                }
            }
        } catch (error) {
            ws.send(JSON.stringify({ 
                type: 'error', 
                message: 'Error processing terminal request', 
                details: error.message 
            }));
        }
    });

    ws.on("close", async () => {
        if (terminals.has(terminalId)) {
            const terminal = terminals.get(terminalId);
            if (terminal.ptyProcess) {
                terminal.ptyProcess.kill();
            }
            terminals.delete(terminalId);
            
            if (clientId && clients.has(clientId)) {
                const client = clients.get(clientId);
                client.connections.delete(ws);
                
                if (client.connections.size === 0) {
                    scheduleCleanup(clientId, clientWorkspace);
                }
            }
        }
    });
});
