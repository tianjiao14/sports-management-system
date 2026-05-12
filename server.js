const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');
const fs = require('fs'); // 新增：文件系统模块用于持久化

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*" } 
});

app.use(express.static(__dirname));

// --- 持久化配置 ---
const DATA_PATH = path.join(__dirname, 'server_state.json');

// --- 全局状态管理 ---
let courtQueues = {};    
let maxCourts = 6;       
let activeMatches = {};  // 重启后锁定状态通常会失效，因为设备连接已重置
let allMatches = {};  
let globalTournamentName = "2026年体育赛事";   

/**
 * 💾 持久化：将当前状态保存到磁盘
 */
function saveStateToDisk() {
    try {
        const dataToSave = {
            courtQueues,
            maxCourts,
            allMatches,
            globalTournamentName
        };
        fs.writeFileSync(DATA_PATH, JSON.stringify(dataToSave, null, 2), 'utf8');
    } catch (err) {
        console.error("数据存档失败:", err);
    }
}

/**
 * 📂 持久化：从磁盘加载状态
 */
function loadStateFromDisk() {
    try {
        if (fs.existsSync(DATA_PATH)) {
            const rawData = fs.readFileSync(DATA_PATH, 'utf8');
            const importedData = JSON.parse(rawData);
            
            courtQueues = importedData.courtQueues || {};
            maxCourts = importedData.maxCourts || 6;
            allMatches = importedData.allMatches || {};
            globalTournamentName = importedData.globalTournamentName || "2026年体育赛事";
            
            console.log("✅ 历史数据已成功恢复");
        }
    } catch (err) {
        console.error("读取历史数据失败或文件格式错误:", err);
    }
}

// 启动服务器时尝试加载数据
loadStateFromDisk();

/**
 * 🌟 核心函数：大屏幕动态排程逻辑 (保留原逻辑)
 */
function sendScoreboardUpdate() {
    const matches = Object.values(allMatches);

    // 1. 获取所有的完赛场次（按完成时间倒序）
    const allFinished = matches
        .filter(m => m.status === 'finished')
        .sort((a, b) => b.finishTime - a.finishTime);

    // 2. 获取所有的未赛/进行中场次
    const otherMatches = matches
        .filter(m => m.status !== 'finished')
        .sort((a, b) => {
            const timeCompare = (a.startTime || "").localeCompare(b.startTime || "");
            if (timeCompare !== 0) return timeCompare;
            return parseInt(a.court) - parseInt(b.court);
        });

    // 3. 核心动态分配逻辑
    let finishedCount = 4;
    if (otherMatches.length < 8) {
        finishedCount = 12 - otherMatches.length; 
    }

    const displayFinished = allFinished.slice(0, finishedCount);
    const displayOther = otherMatches.slice(0, 12 - displayFinished.length);

    const displayList = [...displayFinished, ...displayOther];
    io.emit('scoreboard_data', displayList);
}

io.on('connection', (socket) => {
    console.log('设备连接:', socket.id);

    // 1. 初始化配置发送
    socket.emit('update_config', { maxCourts });
    socket.emit('update_tournament_name', globalTournamentName);

    // 2. 接收管理端场地数更新
    socket.on('update_max_courts', (num) => {
        maxCourts = num;
        io.emit('update_config', { maxCourts }); 
        saveStateToDisk(); // 存档
    });

    // 🌟 接收管理端修改名称的指令并广播
    socket.on('set_tournament_name', (name) => {
        globalTournamentName = name;
        io.emit('update_tournament_name', name);
        console.log("赛事名称已更新为:", name);
        saveStateToDisk(); // 存档
    });

    // 3. 清空队列
    socket.on('clear_court_queues', (courtNum) => {
        if (courtNum === 'all') {
            courtQueues = {};
            allMatches = {};
            activeMatches = {};
            console.log("全系统比赛数据已重置");
        } else {
            courtQueues[courtNum] = [];
            for (let id in allMatches) {
                if (allMatches[id].court == courtNum) delete allMatches[id];
            }
        }
        io.emit('court_queues_cleared', courtNum);
        sendScoreboardUpdate();
        saveStateToDisk(); // 存档
    });

    // 4. 裁判选择负责场地
    socket.on('join_court', (courtNum) => {
        socket.join(`court_room_${courtNum}`);
        socket.emit(`court_${courtNum}_match`, courtQueues[courtNum] || []); 
    });

    // 5. 管理端推送比赛
    socket.on('push_match', (data) => {
        const courtNum = data.court;
        if (!courtQueues[courtNum]) courtQueues[courtNum] = [];
        
        const idx = courtQueues[courtNum].findIndex(m => m.id === data.id);
        if (idx !== -1) courtQueues[courtNum][idx] = data;
        else courtQueues[courtNum].push(data);

        allMatches[data.id] = {
            id: data.id,
            court: data.court,
            p1: data.p1,
            p2: data.p2,
            matchType: data.title,
            startTime: data.time || "00:00",
            p1Score: 0, p2Score: 0, 
            p1Sets: 0, p2Sets: 0,
            status: 'waiting',
            setHistory: "",
            isSwapped: false
        };

        io.to(`court_room_${courtNum}`).emit(`court_${courtNum}_match`, courtQueues[courtNum]);
        sendScoreboardUpdate(); 
        saveStateToDisk(); // 存档
    });

    // 6. 锁定机制 (不需要持久化锁定 ID，因为重启后 Socket 会重新连接)
    socket.on('lock_match', (matchId) => {
        if (activeMatches[matchId] && activeMatches[matchId] !== socket.id) {
            socket.emit('lock_status', { success: false, message: "该场比赛已有其他裁判正在执裁！" });
        } else {
            activeMatches[matchId] = socket.id;
            if (allMatches[matchId]) {
                allMatches[matchId].status = 'playing';
            }
            io.emit('match_occupied', { matchId: matchId, locked: true });
            socket.emit('lock_status', { success: true });
            sendScoreboardUpdate();
            saveStateToDisk(); // 状态变为 playing，保存
        }
    });

    // 7. 实时比分同步
    socket.on('update_score', (data) => {
        io.emit('score_to_manager', data);

       if (allMatches[data.id]) {
            allMatches[data.id].p1Score = data.s1;
            allMatches[data.id].p2Score = data.s2;
            allMatches[data.id].p1Sets = data.p1Sets || 0;
            allMatches[data.id].p2Sets = data.p2Sets || 0;
            allMatches[data.id].isSwapped = data.isSwapped || false; 
            sendScoreboardUpdate();
            saveStateToDisk(); // 关键：实时记录比分，防止崩溃丢失进度
        }
    });

    // 8. 完赛处理
    socket.on('finish_match', (data) => {
        delete activeMatches[data.id];
        
        if (allMatches[data.id]) {
            allMatches[data.id].status = 'finished';
            allMatches[data.id].setHistory = data.details || ""; 
            allMatches[data.id].p1Sets = data.setScore1;
            allMatches[data.id].p2Sets = data.setScore2;
            allMatches[data.id].finishTime = Date.now();
        }

        if (courtQueues[data.court]) {
            let qMatch = courtQueues[data.court].find(m => m.id === data.id);
            if (qMatch) {
                qMatch.isFinished = true;
                qMatch.finalScore = `${data.setScore1}:${data.setScore2}`;
                qMatch.details = data.details;
            }
            io.to(`court_room_${data.court}`).emit(`court_${courtNum}_match`, courtQueues[data.court]);
        }

        io.emit('match_occupied', { matchId: data.id, locked: false });
        io.emit('result_to_manager', data);
        sendScoreboardUpdate();
        saveStateToDisk(); // 记录完赛结果
    });

    // 9. 大屏幕初始化请求
    socket.on('request_all_scores', () => {
        sendScoreboardUpdate();
    });

    // 10. 掉线释放
    socket.on('disconnect', () => {
        for (let mId in activeMatches) {
            if (activeMatches[mId] === socket.id) {
                delete activeMatches[mId];
                io.emit('match_occupied', { matchId: mId, locked: false });
            }
        }
    });
});

// --- 服务器启动 ---
const PORT = 3000;
server.listen(PORT, '0.0.0.0', () => {
    const interfaces = os.networkInterfaces();
    let localIP = '127.0.0.1';
    for (let devName in interfaces) {
        interfaces[devName].forEach((details) => {
            if (details.family === 'IPv4' && !details.internal) {
                localIP = details.address;
            }
        });
    }
    console.log('--------------------------------------');
    console.log(`🚀 赛事系统已启动并已开启数据持久化！`);
    console.log(`💻 管理端: http://${localIP}:${PORT}/index.html`);
    console.log(`🏸 裁判端: http://${localIP}:${PORT}/umpire.html`);
    console.log(`📺 大屏幕: http://${localIP}:${PORT}/scoreboard.html`);
    console.log(`📁 存档文件: ${DATA_PATH}`);
    console.log('--------------------------------------');
});