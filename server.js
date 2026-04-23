const express = require('express');
const http = require('http');
const { Server } = require('socket.io');
const path = require('path');
const os = require('os');

const app = express();
const server = http.createServer(app);
const io = new Server(server, { 
    cors: { origin: "*" } 
});

app.use(express.static(__dirname));

// --- 全局状态管理 (移出连接监听器以提高性能) ---
let courtQueues = {};    
let maxCourts = 6;       
let activeMatches = {};  
let allMatches = {};  
let globalTournamentName = "2026年体育赛事";   
/**
 * 🌟 核心函数：大屏幕动态排程逻辑 (已优化)
 */
function sendScoreboardUpdate() {
    const matches = Object.values(allMatches);

    // 1. 获取所有的完赛场次（按完成时间倒序：最近完赛的排前面）
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

    // 3. 🌟 核心动态分配逻辑：
    let finishedCount = 4;
    if (otherMatches.length < 8) {
        finishedCount = 12 - otherMatches.length; 
    }

    const displayFinished = allFinished.slice(0, finishedCount);
    const displayOther = otherMatches.slice(0, 12 - displayFinished.length);

    // 4. 拼接并发送给大屏幕
    const displayList = [...displayFinished, ...displayOther];
    io.emit('scoreboard_data', displayList);
}

io.on('connection', (socket) => {
    console.log('设备连接:', socket.id);

    // 1. 初始化配置发送
    socket.emit('update_config', { maxCourts });

    // 2. 接收管理端场地数更新
    socket.on('update_max_courts', (num) => {
        maxCourts = num;
        io.emit('update_config', { maxCourts }); 
    });
socket.emit('update_tournament_name', globalTournamentName);

    // 🌟 2. 接收管理端修改名称的指令并广播
    socket.on('set_tournament_name', (name) => {
        globalTournamentName = name;
        io.emit('update_tournament_name', name);
        console.log("赛事名称已更新为:", name);
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
        sendScoreboardUpdate(); // 统一调用
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
    });

    // 6. 锁定机制
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
            allMatches[data.id].isSwapped = data.isSwapped || false; // 🌟 接收并保存裁判的换边状态
            sendScoreboardUpdate();
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

      // 在 server.js 中找到这里，替换掉原来的 filter 逻辑：
        if (courtQueues[data.court]) {
            // 不要删除，而是找到它并打上完赛标记和比分
            let qMatch = courtQueues[data.court].find(m => m.id === data.id);
            if (qMatch) {
                qMatch.isFinished = true;
                qMatch.finalScore = `${data.setScore1}:${data.setScore2}`;
                qMatch.details = data.details;
            }
            io.to(`court_room_${data.court}`).emit(`court_${data.court}_match`, courtQueues[data.court]);
        }

        io.emit('match_occupied', { matchId: data.id, locked: false });
        io.emit('result_to_manager', data);
        sendScoreboardUpdate();
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
    console.log(`🚀 赛事系统已启动！`);
    console.log(`💻 管理端: http://${localIP}:${PORT}/index.html`);
    console.log(`🏸 裁判端: http://${localIP}:${PORT}/umpire.html`);
    console.log(`📺 大屏幕: http://${localIP}:${PORT}/scoreboard.html`);
    console.log('--------------------------------------');
});