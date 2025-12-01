const electron = require('electron');
console.log('electron:', typeof electron);
console.log('electron.app:', electron.app);
console.log('keys:', Object.keys(electron));
if (electron.app) {
  electron.app.quit();
}
