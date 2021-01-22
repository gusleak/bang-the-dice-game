'use strict';
require('dotenv').config();
const express = require('express');
const myDB = require('./connection');
const session = require('express-session');
const passport = require('passport');
const routes = require('./routes.js');

const auth = require('./auth.js');
const game = require('./game.js');

const app = express();
const http = require('http').createServer(app);
const io = require('socket.io')(http);
const passportSocketIo = require('passport.socketio');
const cookieParser = require('cookie-parser');
const { read } = require('fs');
const MongoStore = require('connect-mongo')(session);
const URI = process.env.MONGO_URI;
const store = new MongoStore({ url: URI });

app.set('view engine', 'pug');

app.use('/public', express.static(process.cwd() + '/public'));
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

app.use(session({
  secret: process.env.SESSION_SECRET,
  resave: true,
  saveUninitialized: true,
  cookie: { secure: false },
  key: 'express.sid',
  store: store
}));

app.use(passport.initialize());
app.use(passport.session());

io.use(
  passportSocketIo.authorize({
    cookieParser: cookieParser,
    key: 'express.sid',
    secret: process.env.SESSION_SECRET,
    store: store,
    success: onAuthorizeSuccess,
    fail: onAuthorizeFail
  })
);

myDB(async (client) => {
  const myDataBase = await client.db('database').collection('users')
  
  routes.main(app, myDataBase);
  auth(app, myDataBase);

  // Rooms object: roomId as key, users array as value
  let rooms = {};

  // roomId as key, ready user IDs array
  let readyUsers = {};

  // roomId as key, player attributes object as value
  let players = {};

  io.on('connection', (socket) => {

    let roomId = routes.getRoomId();
    socket.join(roomId);
    
    if (rooms[roomId]) {
      // Do not allow double sessions
      for (let i=0; i < rooms[roomId].length; i++) {
        if (socket.request.user.username == rooms[roomId][i]) {
          socket.disconnect();
          console.log('Disconnecting existing user.');
          return false;
        }
      }

      // Game is played with max 8 players
      if (rooms[roomId].length === 8) {
        socket.disconnect();
        console.log('Player limit reached. Unable to connect.');
        return false;
      }
    }

    // Assign user to room
    if (rooms[roomId]) {
      rooms[roomId].push(socket.request.user.username);
    } else {
      rooms[roomId] = [socket.request.user.username];
    }

    console.log(`User list in room ${roomId}: ${rooms[roomId]}`);
    io.to(roomId).emit('user', {
      name: socket.request.user.username,
      users: rooms[roomId],
      readyUsers: readyUsers[roomId],
      roomId,
      connected: true
    });
    console.log('A user has connected.');
    socket.on('chat message', (message) => {
      io.to(roomId).emit('chat message', { 
        name: socket.request.user.username, message });
    });
    
    socket.on('ready button', (id) => {

      if (readyUsers[id]) {
        let ids = readyUsers[id].map(elem => elem[0]);
        if (ids.indexOf(socket.id) == -1) {

          // If the user is the creator, insert his ID in front of the ready user IDs array
          if (socket.request.user.username == rooms[id][0]) {
            readyUsers[id].unshift([socket.id, socket.request.user.username]);

          // otherwise, push it in the back
          } else {
            readyUsers[id].push([socket.id, socket.request.user.username]);
          }
        
        // If it already exists, remove it
        } else {
          readyUsers[id] = readyUsers[id].filter(elem => elem[0] != socket.id);
        }
      
      // If it is the first ID, store it and create an array
      } else {
        readyUsers[id] = [[socket.id, socket.request.user.username]];
      }
      let posNum = rooms[id].indexOf(socket.request.user.username);

      // If all users ready and more than 3 users connected, the creator can start the game
      if (readyUsers[id].length > 3 && readyUsers[id].length === rooms[id].length) {
        io.to(id).emit('start game', { creatorId: readyUsers[id][0][0] });
      }

      io.to(id).emit('ready button', {  
        name: socket.request.user.username, 
        readyUsers: readyUsers[id], posNum });
    });

    socket.on('assign roles', (id) => {
      players[id] = game.getRoles(rooms[id]);
      let chars = game.getChars(rooms[id]);
      let ids = readyUsers[id].map(elem => elem[0]);
      let usernames = readyUsers[id].map(elem => elem[1]);
      for (let i=0; i < usernames.length; i++) {
        players[id][i].socketId = ids[usernames.indexOf(players[id][i].name)];
        players[id][i].char = chars[i];
      }
      io.to(id).emit('assign roles', { players: players[id] });
    })

    socket.on('start turn', (data) => {
      let dice;
      let arrowIndices;
      if (data.currentDice) {
        arrowIndices = data.currentDice
                            .map((elem, i) => elem == 'arrow' ? i : '')
                            .filter(elem => elem !== '')
                            .filter(diePos => !data.dicePositions.includes(diePos));
        for (let i=0; i < data.dicePositions.length; i++) {
          data.currentDice[data.dicePositions[i]] = game.rollDice(1)[0];
          data.reRolls--;
        }
        dice = data.currentDice;
      } else {
        dice = game.rollDice(5);
      }
      io.to(data.id).emit('start turn', { 
        players: players[data.id],
        dice,
        arrowIndices,
        reRolls: data.reRolls,
        roller: data.roller,
        dicePos: data.dicePositions,
        playerPos: players[data.id]
                    .filter(player => player.alive)
                    .map(player => player.socketId)
                    .indexOf(data.roller)
      });
    })

    socket.on('turn transition', (data) => {
      io.to(data.id).emit('turn transition', data);
    })

    socket.on('lose health', (data) => {
      let name = players[data.id][data.playerPos].name;
      players[data.id][data.playerPos].health--;
      if (players[data.id][data.playerPos].health == 0) {
        players[data.id][data.playerPos].alive = false;
        io.to(data.id).emit('player eliminated', {
          players: players[data.id],
          playerPos: data.playerPos,
          name
        });
      } 
      io.to(data.id).emit('lose health', {
        players: players[data.id],
        playerPos: data.playerPos,
        dmgType: data.dmgType
      });
    })

    socket.on('gain health', (data) => {
      if (players[data.id][data.playerPos].health < players[data.id][data.playerPos].maxHealth) {
        players[data.id][data.playerPos].health++;
        io.to(data.id).emit('gain health', {
          players: players[data.id],
          playerPos: data.playerPos
        })
      }
    })

    socket.on('get arrow', (data) => {
      let emptyArrows = false;
      let eliminated = false;
      let alivePlayers;
      players[data.id][data.pos].arrows += data.arrowsHit;
      if (data.arrowCount <= data.arrowsHit) {
        emptyArrows = true;
        io.to(data.id).emit('get arrow', {
          pos: players[data.id].map(player => player.socketId).indexOf(data.roller),
          arrowCount: data.arrowCount,
          arrowsHit: data.arrowCount
        })
      } else {
        io.to(data.id).emit('get arrow', {
          pos: players[data.id].map(player => player.socketId).indexOf(data.roller),
          arrowCount: data.arrowCount,
          arrowsHit: data.arrowsHit
        })
      }
      if (emptyArrows) {
        setTimeout(() => {
          for (let i = 0; i < players[data.id].length; i++) {
            if (players[data.id][i].alive) {
              players[data.id][i].health -= players[data.id][i].arrows;
              players[data.id][i].arrows = 0;
            }
            if (players[data.id][i].health <= 0) {

              // If eliminated player's turn
              if (players[data.id][i].socketId == data.roller) {
                eliminated = true;
                alivePlayers = players[data.id].filter(player => player.alive);
                let idx = alivePlayers.map(player => player.socketId).indexOf(data.roller);
                let newRoller;
                if (idx + 1 >= alivePlayers.length) {
                  newRoller = alivePlayers[0].socketId;
                } else { newRoller = alivePlayers[idx + 1] }
                io.to(data.id).emit('start turn', {
                  players: players[data.id],
                  dice: game.rollDice(5),
                  playerPos: players[data.id]
                    .filter(player => player.alive)
                    .map(player => player.socketId)
                    .indexOf(newRoller)
                });
              }
              players[data.id][i].alive = false;
              io.to(data.id).emit('player eliminated', { left: alivePlayers.length - 1, playerPos: i, name: players[data.id][i].name });
            }
          }
          io.to(data.id).emit('refill arrows', { players: players[data.id] });
          if (!eliminated) {
            setTimeout(() => {
              io.to(data.id).emit('get arrow', {
                pos: players[data.id].map(player => player.socketId).indexOf(data.roller),
                arrowCount: 9,
                arrowsHit: data.arrowsHit - data.arrowCount
              })
            }, 500);
          }
        }, 500);
      }
    })

    socket.on('disconnect', () => {
      console.log('A user has disconnected.');
      rooms[roomId] = rooms[roomId].filter(user => user !== socket.request.user.username);
      if (readyUsers[roomId]) {
        readyUsers[roomId] = readyUsers[roomId].filter(elem => elem[0] != socket.id);
      }
      // If last user is disconnected, delete the room ID
      if (rooms[roomId].length == 0) {
        delete rooms[roomId];
        delete readyUsers[roomId];
      }
      io.to(roomId).emit('user', {
        name: socket.request.user.username,
        users: rooms[roomId],
        readyUsers: readyUsers[roomId],
        roomId,
        connected: false
      });
    });
  });

}).catch((e) => {
  app.route('/').get((req, res) => {
    res.render('pug', { title: e, message: 'Unable to login' });
  });
});

function onAuthorizeSuccess(data, accept) {
  console.log('Successful connection to socket.io.');
  accept(null, true);
}

function onAuthorizeFail(data, message, error, accept) {
  if (error) throw new Error(message);
  console.log('Failed connection to socket.io:', message);
  accept(null, false);
}

http.listen(process.env.PORT || 3000, () => {
  console.log('Listening on port ' + process.env.PORT);
});