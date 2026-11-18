const { app, BrowserWindow, Menu, Notification, Tray, ipcMain, nativeImage } = require('electron');
const fs = require('node:fs/promises');
const path = require('node:path');

const APP_ID = 'com.taskflow.desktop';
const REMINDER_LEAD_MS = 60 * 60 * 1000;
const MAX_TIMEOUT_MS = 2_147_000_000;
let state = { tasks: [], remindersEnabled: false, sentReminderKeys: [] };
let hasSavedTasks = false;
let mainWindow = null;
let tray = null;
let reminderTimer = null;
let isQuitting = false;
let writeQueue = Promise.resolve();
const stateFile = path.join(app.getPath('userData'), 'taskflow-data.json');

if (process.platform === 'win32') {
  app.setAppUserModelId(APP_ID);
}

function showMainWindow() {
  if (!mainWindow || mainWindow.isDestroyed()) {
    createMainWindow();
    return;
  }
  if (mainWindow.isMinimized()) mainWindow.restore();
  mainWindow.show();
  mainWindow.focus();
}

function notifyRendererOfReminderSetting() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop:reminders-changed', state.remindersEnabled);
  }
}

function reportNotificationStatus(message) {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('desktop:notification-status', { message });
  }
}

function showWindowsNotification(title, body) {
  if (!Notification.isSupported()) {
    const message = 'Windows notifications are unavailable. Check Windows notification settings.';
    reportNotificationStatus(message);
    return { success: false, message };
  }

  try {
    const notification = new Notification({
      title,
      body,
      icon: path.join(__dirname, 'notepad-192.png')
    });
    notification.on('click', showMainWindow);
    notification.on('show', () => reportNotificationStatus('Windows displayed a TaskFlow notification.'));
    notification.on('failed', (_event, error) => {
      const message = `Windows could not display the notification: ${error}`;
      console.error(message);
      reportNotificationStatus(message);
    });
    notification.show();
    return { success: true, message: 'Windows accepted the test notification.' };
  } catch (error) {
    console.error('Unable to show a Windows notification.', error);
    const message = 'Windows could not display a notification. Check Windows notification settings.';
    reportNotificationStatus(message);
    return { success: false, message };
  }
}

function refreshTrayMenu() {
  if (!tray) return;

  const template = [
    { label: 'Open TaskFlow', click: showMainWindow },
    {
      label: 'Enable task reminders',
      type: 'checkbox',
      checked: state.remindersEnabled,
      click: (item) => {
        setRemindersEnabled(item.checked).catch((error) => {
          console.error('Unable to update reminder setting from the tray.', error);
        });
      }
    }
  ];

  if (process.platform === 'win32') {
    template.push({
      label: 'Start when I sign in',
      type: 'checkbox',
      checked: app.getLoginItemSettings().openAtLogin,
      click: (item) => {
        app.setLoginItemSettings({
          openAtLogin: item.checked,
          path: process.execPath,
          args: ['--hidden']
        });
      }
    });
  }

  template.push(
    { type: 'separator' },
    {
      label: 'Quit TaskFlow',
      click: () => {
        isQuitting = true;
        app.quit();
      }
    }
  );
  tray.setContextMenu(Menu.buildFromTemplate(template));
}

function createTray() {
  if (tray) return;
  const icon = nativeImage.createFromPath(path.join(__dirname, 'notepad-192.png'));
  tray = new Tray(icon);
  tray.setToolTip('TaskFlow');
  tray.on('click', showMainWindow);
  tray.on('double-click', showMainWindow);
  refreshTrayMenu();
}

function createMainWindow() {
  if (mainWindow && !mainWindow.isDestroyed()) {
    showMainWindow();
    return;
  }

  mainWindow = new BrowserWindow({
    width: 920,
    height: 820,
    minWidth: 360,
    minHeight: 540,
    show: !process.argv.includes('--hidden'),
    icon: path.join(__dirname, 'notepad-192.png'),
    backgroundColor: '#f4f6fb',
    webPreferences: {
      preload: path.join(__dirname, 'preload.cjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true
    }
  });

  mainWindow.loadFile(path.join(__dirname, 'index.html')).catch((error) => {
    console.error('Unable to load TaskFlow.', error);
  });

  mainWindow.on('close', (event) => {
    if (!isQuitting) {
      event.preventDefault();
      mainWindow.hide();
    }
  });

  mainWindow.on('closed', () => {
    mainWindow = null;
  });
}

function validateTasks(tasks) {
  if (!Array.isArray(tasks)) throw new TypeError('Tasks must be an array.');

  return tasks.map((task) => {
    if (!task || typeof task !== 'object' || typeof task.text !== 'string') {
      throw new TypeError('Each task must include text.');
    }

    return {
      id: typeof task.id === 'string' ? task.id : '',
      text: task.text.slice(0, 120),
      completed: Boolean(task.completed),
      dueDate: typeof task.dueDate === 'string' ? task.dueDate : '',
      dueTime: typeof task.dueTime === 'string' ? task.dueTime : '09:00',
      priority: ['none', 'low', 'medium', 'high'].includes(task.priority) ? task.priority : 'none'
    };
  });
}

async function loadState() {
  try {
    const stored = JSON.parse(await fs.readFile(stateFile, 'utf8'));
    state = {
      tasks: validateTasks(Array.isArray(stored.tasks) ? stored.tasks : []),
      remindersEnabled: stored.remindersEnabled === true,
      sentReminderKeys: Array.isArray(stored.sentReminderKeys)
        ? stored.sentReminderKeys.filter((key) => typeof key === 'string')
        : []
    };
    hasSavedTasks = Array.isArray(stored.tasks);
  } catch (error) {
    if (error.code === 'ENOENT') return;
    console.error('Unable to read TaskFlow desktop data.', error);
    throw error;
  }
}

function persistState() {
  const contents = JSON.stringify(state, null, 2);
  writeQueue = writeQueue.catch(() => {}).then(async () => {
    await fs.mkdir(path.dirname(stateFile), { recursive: true });
    const temporaryFile = `${stateFile}.tmp`;
    await fs.writeFile(temporaryFile, contents, 'utf8');
    await fs.rename(temporaryFile, stateFile);
  });
  return writeQueue;
}

function dueTimestamp(task) {
  if (!task.dueDate || !task.dueTime || !/^\d{4}-\d{2}-\d{2}$/.test(task.dueDate) || !/^\d{2}:\d{2}$/.test(task.dueTime)) {
    return NaN;
  }
  return new Date(`${task.dueDate}T${task.dueTime}:00`).getTime();
}

function reminderKey(task, dueAt) {
  return `${task.id}:${dueAt}`;
}

function formatDueTime(timestamp) {
  return new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(timestamp);
}

function scheduleNextReminder() {
  clearTimeout(reminderTimer);
  reminderTimer = null;
  if (!state.remindersEnabled) return;

  const now = Date.now();
  let next = null;
  const validKeys = [];
  for (const task of state.tasks) {
    if (task.completed) continue;
    const dueAt = dueTimestamp(task);
    if (!Number.isFinite(dueAt) || dueAt <= now) continue;

    const key = reminderKey(task, dueAt);
    validKeys.push(key);
    if (state.sentReminderKeys.includes(key)) continue;

    const remindAt = dueAt - REMINDER_LEAD_MS;
    if (!next || remindAt < next.remindAt) next = { task, dueAt, key, remindAt };
  }

  state.sentReminderKeys = state.sentReminderKeys.filter((key) => validKeys.includes(key));
  if (!next) return;

  const delay = Math.max(0, Math.min(next.remindAt - now, MAX_TIMEOUT_MS));
  reminderTimer = setTimeout(() => {
    if (Date.now() < next.remindAt) {
      scheduleNextReminder();
      return;
    }
    if (next.dueAt > Date.now() && !state.sentReminderKeys.includes(next.key)) {
      const task = state.tasks.find((candidate) => candidate.id === next.task.id && !candidate.completed);
      if (task && dueTimestamp(task) === next.dueAt) {
        const result = showWindowsNotification(
          `Task due soon: ${task.text}`,
          `Due ${formatDueTime(next.dueAt)}.`
        );
        state.sentReminderKeys.push(next.key);
        persistState().then(() => {
          if (result.success) reportNotificationStatus(`Reminder sent for “${task.text}”.`);
        }).catch((error) => console.error('Unable to save reminder state.', error));
      }
    }
    scheduleNextReminder();
  }, delay);
}

async function setRemindersEnabled(enabled) {
  state.remindersEnabled = Boolean(enabled);
  await persistState();
  scheduleNextReminder();
  refreshTrayMenu();
  notifyRendererOfReminderSetting();
}

async function startApp() {
  await loadState();
  createTray();
  createMainWindow();
  scheduleNextReminder();
}

const hasSingleInstance = app.requestSingleInstanceLock();
if (!hasSingleInstance) {
  app.quit();
} else {
  app.on('second-instance', showMainWindow);

  app.whenReady().then(startApp).catch((error) => {
    console.error('TaskFlow desktop app failed to start.', error);
    app.quit();
  });

  app.on('before-quit', () => {
    isQuitting = true;
    clearTimeout(reminderTimer);
  });

  app.on('window-all-closed', () => {
    if (process.platform === 'darwin' && isQuitting) app.quit();
  });
}

ipcMain.handle('desktop:get-state', () => ({
  tasks: state.tasks,
  remindersEnabled: state.remindersEnabled,
  hasSavedTasks
}));

ipcMain.handle('desktop:save-tasks', async (_event, tasks) => {
  state.tasks = validateTasks(tasks);
  hasSavedTasks = true;
  await persistState();
  scheduleNextReminder();
});

ipcMain.handle('desktop:set-reminders', async (_event, enabled) => {
  if (typeof enabled !== 'boolean') throw new TypeError('Reminder setting must be a boolean.');
  await setRemindersEnabled(enabled);
});

ipcMain.handle('desktop:test-notification', () => showWindowsNotification(
  'TaskFlow notification test',
  'Windows notifications are working for TaskFlow.'
));
