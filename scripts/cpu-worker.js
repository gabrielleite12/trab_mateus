const { parentPort } = require('worker_threads');

let running = true;
let dutyCycle = 0; // 0.0 to 1.0
const cycleDurationMs = 100;

parentPort.on('message', (msg) => {
    if (msg.type === 'start') {
        dutyCycle = msg.dutyCycle;
        runCycle();
    } else if (msg.type === 'stop') {
        running = false;
        process.exit(0);
    }
});

function runCycle() {
    if (!running) return;

    const busyTime = dutyCycle * cycleDurationMs;
    const sleepTime = cycleDurationMs - busyTime;

    const start = Date.now();
    // Busy wait for busyTime
    while (Date.now() - start < busyTime) {
        // burn CPU
    }

    if (sleepTime > 0) {
        setTimeout(runCycle, sleepTime);
    } else {
        setImmediate(runCycle);
    }
}
