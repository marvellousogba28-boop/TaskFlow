const { contextBridge, ipcRenderer } = require('electron');

contextBridge.exposeInMainWorld('desktopApp', {
  isDesktop: true,
  getState: () => ipcRenderer.invoke('desktop:get-state'),
  saveTasks: (tasks) => ipcRenderer.invoke('desktop:save-tasks', tasks),
  setRemindersEnabled: (enabled) => ipcRenderer.invoke('desktop:set-reminders', enabled),
  sendTestNotification: () => ipcRenderer.invoke('desktop:test-notification'),
  onRemindersChanged: (callback) => {
    const listener = (_event, enabled) => callback(enabled);
    ipcRenderer.on('desktop:reminders-changed', listener);
    return () => ipcRenderer.removeListener('desktop:reminders-changed', listener);
  },
  onNotificationStatus: (callback) => {
    const listener = (_event, status) => callback(status);
    ipcRenderer.on('desktop:notification-status', listener);
    return () => ipcRenderer.removeListener('desktop:notification-status', listener);
  }
});
