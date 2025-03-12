const express = require("express");
const cors = require("cors");
const fs = require("fs");
const { exec, spawn } = require("child_process");
const WebSocket = require("ws");
const { v4: uuidv4 } = require("uuid");
const path = require("path");
const http = require("http");  // Changed to HTTP module

const app = express();
const port = 4000;

app.use(express.json());
app.use(cors());

const clients = new Map();

const WORKSPACE_BASE = "./docker_workspaces";
if (!fs.existsSync(WORKSPACE_BASE)) {
    fs.mkdirSync(WORKSPACE_BASE, { recursive: true });
}

const getTasksFilePath = (uuid) => `./tasks_galaga_${uuid}.json`;

const readTasksData = (uuid) => {
    const filePath = getTasksFilePath(uuid);
    if (!fs.existsSync(filePath)) {
        fs.copyFileSync("./tasks_galaga.json", filePath);
    }
    try {
        return JSON.parse(fs.readFileSync(filePath, "utf8"));
    } catch (err) {
        console.error("Error reading tasks file:", err);
        return { tasks: [], last_completed_task_id: null };
    }
};

const writeTasksData = (uuid, data) => {
    try {
        fs.writeFileSync(getTasksFilePath(uuid), JSON.stringify(data, null, 2), "utf8");
    } catch (err) {
        console.error("Error writing tasks file:", err);
    }
};

// Add this endpoint to get Docker processes status
app.get("/docker/status", (req, res) => {
    exec("docker ps --format '{{.ID}}\t{{.Names}}\t{{.Status}}\t{{.Image}}'", (error, stdout, stderr) => {
        if (error) {
            console.error(`Error getting docker status: ${error.message}`);
            return res.status(500).json({
                error: "Failed to retrieve docker status",
                details: error.message
            });
        }

        if (stderr) {
            console.error(`Docker command stderr: ${stderr}`);
        }

        const containers = stdout.trim().split('\n')
            .filter(line => line.trim() !== '')
            .map(line => {
                const [id, name, status, image] = line.split('\t');
                return { id, name, status, image };
            });

        const clientContainers = containers.filter(container =>
            container.name.startsWith('rust-workspace-'));

        res.json({
            total_containers: containers.length,
            client_containers: clientContainers.length,
            containers: clientContainers,
            all_containers: containers
        });
    });
});

app.get("/connect", (req, res) => {
    const sessionId = uuidv4();

    res.json({
        status: "online",
        sessionId: sessionId,
        serverPort: port,
        webSocketUrl: `ws://${req.headers.host.split(':')[0]}:${port}`,  // Changed to use ws instead of wss
        message: "Use the provided sessionId when establishing WebSocket connection"
    });
});

app.get("/health", (req, res) => {
    res.json({
        status: "healthy",
        clients: clients.size,
        uptime: process.uptime()
    });
});

app.get("/galaga/tasks", (req, res) => {
    const { uuid } = req.query;
    if (!uuid) return res.status(400).json({ message: "UUID is required" });
    res.json(readTasksData(uuid).tasks);
});

app.get("/galaga/tasks/:id", (req, res) => {
    const { uuid } = req.query;
    if (!uuid) return res.status(400).json({ message: "UUID is required" });
    const task = readTasksData(uuid).tasks.find((t) => t.task_id === parseInt(req.params.id));
    task ? res.json(task) : res.status(404).json({ message: "Task not found" });
});

app.post("/galaga/tasks/:id/complete", (req, res) => {
    const { uuid } = req.query;
    if (!uuid) return res.status(400).json({ message: "UUID is required" });
    const data = readTasksData(uuid);
    const task = data.tasks.find((t) => t.task_id === parseInt(req.params.id));
    if (task) {
        task.completed = true;
        data.last_completed_task_id = task.task_id;
        writeTasksData(uuid, data);
        res.json({ message: "Task marked as complete", task });
    } else {
        res.status(404).json({ message: "Task not found" });
    }
});

app.get("/galaga/next_task", (req, res) => {
    const { uuid } = req.query;
    if (!uuid) return res.status(400).json({ message: "UUID is required" });
    const data = readTasksData(uuid);
    const nextTask = data.tasks.find((t) => t.task_id > (data.last_completed_task_id || 0) && !t.completed);
    res.json(nextTask || { message: "All tasks are completed" });
});

const createContainer = (clientId, workspacePath) => {
    return new Promise((resolve, reject) => {
        const containerName = `rust-workspace-${clientId}`;

        const dockerfilePath = path.join(workspacePath, "Dockerfile");
        const dockerfileContent = `
FROM rust:latest
WORKDIR /usr/src/app
CMD ["tail", "-f", "/dev/null"]
`;

        fs.writeFileSync(dockerfilePath, dockerfileContent);

        exec(`docker build -t ${containerName} ${workspacePath} && docker run -d --name ${containerName} --rm ${containerName}`,
            (error, stdout, stderr) => {
                if (error) {
                    console.error(`Error creating container: ${error.message}`);
                    return reject(error);
                }
                if (stderr) {
                    console.error(`stderr: ${stderr}`);
                }
                console.log(`Container created: ${containerName}`);
                resolve(containerName);
            }
        );
    });
};

const runCommandInContainer = (containerName, command) => {
    return spawn("docker", ["exec", containerName, "bash", "-c", command], {
        shell: false
    });
};

const copyToContainer = (containerName, source, dest) => {
    return new Promise((resolve, reject) => {
        exec(`docker cp ${source} ${containerName}:${dest}`, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error copying to container: ${error.message}`);
                return reject(error);
            }
            resolve();
        });
    });
};

const removeContainer = (containerName) => {
    return new Promise((resolve, reject) => {
        exec(`docker stop ${containerName} || true`, (error, stdout, stderr) => {
            if (error) {
                console.error(`Error stopping container: ${error.message}`);
                return reject(error);
            }
            resolve();
        });
    });
};

// Create HTTP server instead of HTTPS
const server = http.createServer(app);  // Changed to HTTP server
server.listen(port, () => console.log(`Server running on http://localhost:${port}`));

// Create WebSocket server
const wss = new WebSocket.Server({ server });

wss.on("connection", async (ws) => {
    const clientId = uuidv4();
    const clientWorkspace = `${WORKSPACE_BASE}/${clientId}`;
    const containerName = `rust-workspace-${clientId}`;

    if (!fs.existsSync(clientWorkspace)) {
        fs.mkdirSync(clientWorkspace, { recursive: true });
        if (!fs.existsSync(`${clientWorkspace}/src`)) {
            fs.mkdirSync(`${clientWorkspace}/src`, { recursive: true });
        }
    }

    try {
        await createContainer(clientId, clientWorkspace);

        clients.set(clientId, {
            ws,
            containerName,
            workspace: clientWorkspace,
            process: null
        });

        console.log(`Client connected: ${clientId}`);
        ws.send(JSON.stringify({ clientId }));

    } catch (error) {
        console.error(`Failed to create container for client ${clientId}:`, error);
        ws.send(JSON.stringify({
            error: "Failed to create your workspace",
            details: error.message
        }));
        ws.close();
        return;
    }

    ws.on("message", async (message) => {
        try {
            const data = JSON.parse(message);
            const { cargoToml, mainRs, action, clientId: receivedClientId } = data;

            const activeClientId = receivedClientId || clientId;
            const client = clients.get(activeClientId);

            if (!client) {
                ws.send(JSON.stringify({
                    error: "Invalid client ID or session expired"
                }));
                return;
            }

            if (action === "stop") {
                if (client.process) {
                    client.process.kill("SIGTERM");
                    client.process = null;
                    ws.send(JSON.stringify({
                        status: "Rust process stopped",
                        clientId: activeClientId
                    }));
                } else {
                    ws.send(JSON.stringify({
                        status: "No Rust process running",
                        clientId: activeClientId
                    }));
                }
                return;
            }

            console.log(`Processing request for client: ${activeClientId}`);

            fs.writeFileSync(`${client.workspace}/Cargo.toml`, cargoToml, "utf8");
            fs.writeFileSync(`${client.workspace}/src/main.rs`, mainRs, "utf8");

            try {
                await runCommandInContainer(client.containerName, "mkdir -p /usr/src/app/src").on('exit', async () => {
                    await copyToContainer(client.containerName, `${client.workspace}/Cargo.toml`, "/usr/src/app/Cargo.toml");
                    await copyToContainer(client.containerName, `${client.workspace}/src/main.rs`, "/usr/src/app/src/main.rs");

                    if (client.process) {
                        client.process.kill("SIGTERM");
                    }

                    client.process = runCommandInContainer(client.containerName, "cd /usr/src/app && cargo run");

                    client.process.stdout.on("data", (data) => {
                        if (client.ws.readyState === WebSocket.OPEN) {
                            client.ws.send(JSON.stringify({
                                output: data.toString(),
                                clientId: activeClientId
                            }));
                        }
                    });

                    client.process.stderr.on("data", (data) => {
                        if (client.ws.readyState === WebSocket.OPEN) {
                            client.ws.send(JSON.stringify({
                                error: data.toString(),
                                clientId: activeClientId
                            }));
                        }
                    });

                    client.process.on("close", (code) => {
                        if (client.ws.readyState === WebSocket.OPEN) {
                            client.ws.send(JSON.stringify({
                                status: `Process exited with code ${code}`,
                                clientId: activeClientId
                            }));
                        }
                        client.process = null;
                    });
                });
            } catch (error) {
                console.error("Error copying files or running cargo:", error);
                ws.send(JSON.stringify({
                    error: "Failed to run your code",
                    details: error.message,
                    clientId: activeClientId
                }));
            }
        } catch (error) {
            console.error("Error processing message:", error);
            ws.send(JSON.stringify({
                error: "Error processing your request",
                details: error.message
            }));
        }
    });

    ws.on("close", async () => {
        const client = clients.get(clientId);
        if (client) {
            if (client.process) {
                client.process.kill("SIGTERM");
            }

            try {
                await removeContainer(client.containerName);
                console.log(`Container removed: ${client.containerName}`);

                fs.rmSync(client.workspace, { recursive: true, force: true });
                console.log(`Workspace removed: ${client.workspace}`);
            } catch (error) {
                console.error(`Error cleaning up client ${clientId}:`, error);
            }

            clients.delete(clientId);
            console.log(`Client disconnected: ${clientId}`);
        }
    });
});

setInterval(() => {
    const now = Date.now();
    clients.forEach(async (client, id) => {
        if (client.ws.readyState !== WebSocket.OPEN) {
            if (client.process) {
                client.process.kill("SIGTERM");
            }

            try {
                await removeContainer(client.containerName);
                console.log(`Container removed for stale client: ${client.containerName}`);

                fs.rmSync(client.workspace, { recursive: true, force: true });
                console.log(`Workspace removed for stale client: ${client.workspace}`);
            } catch (error) {
                console.error(`Error cleaning up stale client ${id}:`, error);
            }

            clients.delete(id);
            console.log(`Cleaned up stale client: ${id}`);
        }
    });
}, 60000);