const express = require("express");
const cors = require("cors");
const fs = require("fs");

const app = express();
const port = 4000;

app.use(express.json());
app.use(cors());

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

// API to fetch all tasks for a user
app.get("/galaga/tasks", (req, res) => {
    const { uuid } = req.query;
    if (!uuid) return res.status(400).json({ message: "UUID is required" });
    res.json(readTasksData(uuid).tasks);
});

// API to fetch a specific task
app.get("/galaga/tasks/:id", (req, res) => {
    const { uuid } = req.query;
    if (!uuid) return res.status(400).json({ message: "UUID is required" });
    const task = readTasksData(uuid).tasks.find((t) => t.task_id === parseInt(req.params.id));
    task ? res.json(task) : res.status(404).json({ message: "Task not found" });
});

// API to mark a task as completed
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

// API to fetch the next task
app.get("/galaga/next_task", (req, res) => {
    const { uuid } = req.query;
    if (!uuid) return res.status(400).json({ message: "UUID is required" });

    const data = readTasksData(uuid);
    const nextTask = data.tasks.find((t) => t.task_id > (data.last_completed_task_id || 0) && !t.completed);
    res.json(nextTask || { message: "All tasks are completed" });
});

app.listen(port, () => console.log(`Task Server running on http://localhost:${port}`));
