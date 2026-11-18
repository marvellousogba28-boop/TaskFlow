const taskInput = document.getElementById('task-input');
const dueDateInput = document.getElementById('due-date-input');
const dueTimeInput = document.getElementById('due-time-input');
const priorityInput = document.getElementById('priority-input');
const addTaskBtn = document.getElementById('add-task-btn');
const taskList = document.getElementById('task-list');
const emptyMessage = document.getElementById('empty-message');
const taskCount = document.getElementById('task-count');
const taskCountLabel = document.getElementById('task-count-label');
const clearCompletedBtn = document.getElementById('clear-completed-btn');
const progressRing = document.getElementById('progress-ring');
const progressText = document.getElementById('progress-text');
const todayLabel = document.getElementById('today-label');
const themeToggle = document.getElementById('theme-toggle');
const filterButtons = [...document.querySelectorAll('.filter-btn')];
const deleteDialog = document.getElementById('delete-dialog');
const confirmDeleteBtn = document.getElementById('confirm-delete');
const toast = document.getElementById('toast');
const toastMessage = document.getElementById('toast-message');
const toastAction = document.getElementById('toast-action');
const emptyTitle = document.getElementById('empty-title');
const emptyCopy = document.getElementById('empty-copy');
const reminderToggle = document.getElementById('reminder-toggle');
const reminderStatus = document.getElementById('reminder-status');
const reminderNote = document.getElementById('reminder-note');
const testNotificationBtn = document.getElementById('test-notification-btn');
const installBtn = document.getElementById('install-btn');
const saveStatus = document.getElementById('save-status');

let activeFilter = 'all';
let pendingDeleteTask = null;
let undoAction = null;
let toastTimer = null;
let reminderTimer = null;
let deferredInstallPrompt = null;
let autoSaveTimer = null;
const reminderLeadMs = 60 * 60 * 1000;
const autoSaveDelayMs = 350;

function updateSaveStatus(message, state = 'saved') {
  saveStatus.textContent = message;
  saveStatus.dataset.state = state;
}

function saveDraftToLocalStorage() {
  const draft = {
    text: taskInput.value,
    dueDate: dueDateInput.value,
    dueTime: dueTimeInput.value,
    priority: priorityInput.value
  };
  localStorage.setItem('taskDraft', JSON.stringify(draft));
}

function scheduleAutoSave() {
  updateSaveStatus('Saving changes…', 'saving');
  clearTimeout(autoSaveTimer);
  autoSaveTimer = setTimeout(() => {
    try {
      saveTasksToLocalStorage();
      saveDraftToLocalStorage();
      if (!window.desktopApp) updateSaveStatus('All changes saved on this device.');
    } catch (error) {
      console.error('Unable to save task changes.', error);
      updateSaveStatus('Could not save changes. Check this browser’s storage settings.', 'error');
    }
  }, autoSaveDelayMs);
}

function loadDraftFromLocalStorage() {
  try {
    const storedDraft = localStorage.getItem('taskDraft');
    if (!storedDraft) return;
    const draft = JSON.parse(storedDraft);
    if (!draft || typeof draft !== 'object') throw new TypeError('Saved task draft is not valid.');

    taskInput.value = typeof draft.text === 'string' ? draft.text : '';
    dueDateInput.value = typeof draft.dueDate === 'string' ? draft.dueDate : '';
    dueTimeInput.value = typeof draft.dueTime === 'string' ? draft.dueTime : '09:00';
    priorityInput.value = ['none', 'low', 'medium', 'high'].includes(draft.priority) ? draft.priority : 'none';
  } catch (error) {
    console.error('Unable to restore the saved task draft.', error);
    updateSaveStatus('Could not restore the last unsent task draft.', 'error');
  }
}

function createTaskId() {
  return typeof crypto !== 'undefined' && crypto.randomUUID
    ? crypto.randomUUID()
    : `${Date.now()}-${Math.random().toString(36).slice(2)}`;
}

function capitalizeFirstLetter(text) {
  if (!text) return '';
  return text.charAt(0).toUpperCase() + text.slice(1);
}

function todayString() {
  const today = new Date();
  const year = today.getFullYear();
  const month = String(today.getMonth() + 1).padStart(2, '0');
  const day = String(today.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

function formatDueDate(value) {
  if (!value) return '';
  const date = new Date(`${value}T00:00:00`);
  return new Intl.DateTimeFormat('en', {
    month: 'short',
    day: 'numeric'
  }).format(date);
}

function formatDueTime(value) {
  if (!value) return '';
  const [hours, minutes] = value.split(':').map(Number);
  const date = new Date();
  date.setHours(hours, minutes, 0, 0);
  return new Intl.DateTimeFormat('en', {
    hour: 'numeric',
    minute: '2-digit'
  }).format(date);
}

function reminderIsEnabled() {
  return localStorage.getItem('remindersEnabled') === 'true';
}

function updateReminderUi() {
  if (window.desktopApp) {
    reminderToggle.disabled = false;
    testNotificationBtn.hidden = false;
    reminderNote.textContent = 'Windows notifications work while TaskFlow is running, including in the system tray.';
    const enabled = reminderIsEnabled();
    reminderToggle.textContent = enabled ? 'Turn off reminders' : 'Enable reminders';
    reminderStatus.textContent = enabled
      ? 'Windows reminders are on. TaskFlow can send reminders while it runs in the system tray.'
      : 'Reminders are off. Enable them to get Windows notifications one hour before tasks are due.';
    return;
  }

  if (!('Notification' in window)) {
    testNotificationBtn.hidden = true;
    reminderStatus.textContent = 'Notifications are not supported in this browser.';
    reminderToggle.disabled = true;
    return;
  }
  if (!window.isSecureContext) {
    testNotificationBtn.hidden = true;
    reminderStatus.textContent = 'Notifications require HTTPS or localhost.';
    reminderToggle.disabled = true;
    return;
  }
  if (Notification.permission === 'denied') {
    testNotificationBtn.hidden = true;
    reminderStatus.textContent = 'Notifications are blocked. Allow them for this site in your browser settings.';
    reminderToggle.disabled = true;
    return;
  }

  reminderToggle.disabled = false;
  testNotificationBtn.hidden = true;
  reminderNote.textContent = 'Browser reminders work while this app is open.';
  const enabled = reminderIsEnabled() && Notification.permission === 'granted';
  reminderToggle.textContent = enabled ? 'Turn off reminders' : 'Enable reminders';
  reminderStatus.textContent = enabled
    ? 'Reminders are on. You will be notified one hour before a task is due.'
    : 'Reminders are off. Enable notifications to get a reminder one hour before a task is due.';
}

function readSentReminders() {
  try {
    const stored = JSON.parse(localStorage.getItem('sentTaskReminders') || '[]');
    return Array.isArray(stored) ? stored : [];
  } catch {
    localStorage.removeItem('sentTaskReminders');
    return [];
  }
}

async function showTaskReminder(task) {
  const data = taskData(task);
  const title = `Task due soon: ${data.text}`;
  const options = {
    body: `Due ${formatDueDate(data.dueDate)} at ${formatDueTime(data.dueTime)}.`,
    icon: new URL('notepad-192.png', document.baseURI).href,
    tag: `task-${data.id}-${data.dueDate}-${data.dueTime}`
  };

  if ('serviceWorker' in navigator) {
    try {
      const registration = await navigator.serviceWorker.ready;
      await registration.showNotification(title, options);
      return;
    } catch (error) {
      console.error('Service worker notification failed; trying the browser notification API.', error);
    }
  }
  new Notification(title, options);
}

async function checkTaskReminders() {
  if (!reminderIsEnabled() || !('Notification' in window) || Notification.permission !== 'granted') return;

  const sent = readSentReminders();
  const now = Date.now();
  let changed = false;

  for (const task of taskList.querySelectorAll('.task:not(.completed)')) {
    const { id, dueDate, dueTime } = taskData(task);
    if (!dueDate || !dueTime) continue;

    const dueAt = new Date(`${dueDate}T${dueTime}:00`).getTime();
    if (!Number.isFinite(dueAt) || now >= dueAt) continue;

    const reminderKey = `${id}:${dueAt}`;
    if (now < dueAt - reminderLeadMs || sent.includes(reminderKey)) continue;

    await showTaskReminder(task);
    sent.push(reminderKey);
    changed = true;
  }

  if (changed) localStorage.setItem('sentTaskReminders', JSON.stringify(sent));
}

function startReminderChecks() {
  clearInterval(reminderTimer);
  if (window.desktopApp) return;
  if (!reminderIsEnabled() || !('Notification' in window) || Notification.permission !== 'granted') return;
  checkTaskReminders().catch((error) => {
    console.error('Unable to check task reminders.', error);
  });
  reminderTimer = setInterval(() => {
    checkTaskReminders().catch((error) => {
      console.error('Unable to check task reminders.', error);
    });
  }, 15000);
}

async function registerServiceWorker() {
  if (window.desktopApp) return;
  if (!('serviceWorker' in navigator)) return;
  try {
    await navigator.serviceWorker.register('./service-worker.js');
  } catch (error) {
    console.error('Unable to register the app service worker.', error);
  }
}

function showToast(message, actionLabel = '', action = null) {
  clearTimeout(toastTimer);
  toastMessage.textContent = message;
  toastAction.hidden = !action;
  toastAction.textContent = actionLabel;
  undoAction = action;
  toast.hidden = false;
  toastTimer = setTimeout(hideToast, 5000);
}

function hideToast() {
  toast.hidden = true;
  undoAction = null;
}

function renderTask(text, completed = false, dueDate = '', dueTime = '09:00', priority = 'none', id = createTaskId()) {
  const task = document.createElement('li');
  task.className = 'task';
  task.draggable = true;
  task.dataset.id = id;
  task.dataset.dueDate = dueDate;
  task.dataset.dueTime = dueTime;
  task.dataset.priority = priority;
  if (completed) task.classList.add('completed');

  const completeCheckbox = document.createElement('input');
  completeCheckbox.type = 'checkbox';
  completeCheckbox.className = 'complete-checkbox';
  completeCheckbox.checked = completed;

  const content = document.createElement('div');
  content.className = 'task-content';

  const taskText = document.createElement('span');
  taskText.className = 'task-text';
  taskText.textContent = text;

  const details = document.createElement('div');
  details.className = 'task-details';

  if (dueDate) {
    const dueBadge = document.createElement('span');
    dueBadge.className = 'task-badge due';
    dueBadge.textContent = `Due ${formatDueDate(dueDate)} at ${formatDueTime(dueTime)}`;
    details.appendChild(dueBadge);
  }

  if (priority !== 'none') {
    const priorityBadge = document.createElement('span');
    priorityBadge.className = `task-badge priority-${priority}`;
    priorityBadge.textContent = `${capitalizeFirstLetter(priority)} priority`;
    details.appendChild(priorityBadge);
  }

  content.append(taskText, details);

  const actions = document.createElement('div');
  actions.className = 'task-actions';

  const editBtn = document.createElement('button');
  editBtn.type = 'button';
  editBtn.className = 'edit-btn';
  editBtn.textContent = '✎';
  editBtn.setAttribute('aria-label', `Edit "${text}"`);

  const deleteBtn = document.createElement('button');
  deleteBtn.type = 'button';
  deleteBtn.className = 'delete-btn';
  deleteBtn.textContent = '⌫';
  deleteBtn.setAttribute('aria-label', `Delete "${text}"`);

  actions.append(editBtn, deleteBtn);
  task.append(completeCheckbox, content, actions);
  taskList.appendChild(task);

  completeCheckbox.setAttribute('aria-label', `Mark "${text}" as ${completed ? 'not completed' : 'completed'}`);
  if (dueDate && dueDate < todayString() && !completed) task.classList.add('overdue');

  completeCheckbox.addEventListener('change', () => {
    task.classList.toggle('completed', completeCheckbox.checked);
    task.classList.toggle('overdue', dueDate < todayString() && !completeCheckbox.checked);
    completeCheckbox.setAttribute('aria-label', `Mark "${taskText.textContent}" as ${completeCheckbox.checked ? 'not completed' : 'completed'}`);
    saveTasksToLocalStorage();
    updateTaskUi();
  });

  deleteBtn.addEventListener('click', () => {
    pendingDeleteTask = task;
    if (typeof deleteDialog.showModal === 'function') deleteDialog.showModal();
  });

  editBtn.addEventListener('click', () => startEditingTask(task, taskText));

  task.addEventListener('dragstart', () => task.classList.add('dragging'));
  task.addEventListener('dragend', () => {
    task.classList.remove('dragging');
    taskList.querySelectorAll('.drag-over').forEach((item) => item.classList.remove('drag-over'));
    saveTasksToLocalStorage();
  });
  task.addEventListener('dragover', (event) => {
    event.preventDefault();
    const dragging = taskList.querySelector('.dragging');
    if (dragging && dragging !== task) task.classList.add('drag-over');
  });
  task.addEventListener('dragleave', () => task.classList.remove('drag-over'));
  task.addEventListener('drop', (event) => {
    event.preventDefault();
    task.classList.remove('drag-over');
    const dragging = taskList.querySelector('.dragging');
    if (!dragging || dragging === task) return;
    const draggedRect = task.getBoundingClientRect();
    const after = event.clientY > draggedRect.top + draggedRect.height / 2;
    taskList.insertBefore(dragging, after ? task.nextSibling : task);
  });

  updateTaskUi();
}

function addTask() {
  const rawText = taskInput.value.trim();
  if (!rawText) {
    taskInput.focus();
    return;
  }
  clearTimeout(autoSaveTimer);
  renderTask(
    capitalizeFirstLetter(rawText),
    false,
    dueDateInput.value,
    dueTimeInput.value,
    priorityInput.value
  );
  saveTasksToLocalStorage();
  localStorage.removeItem('taskDraft');
  taskInput.value = '';
  dueDateInput.value = '';
  dueTimeInput.value = '09:00';
  priorityInput.value = 'none';
  taskInput.focus();
  updateTaskUi();
  startReminderChecks();
}

function startEditingTask(task, taskText) {
  if (task.querySelector('.edit-input')) return;

  const editInput = document.createElement('input');
  let cancelled = false;
  editInput.type = 'text';
  editInput.className = 'edit-input';
  editInput.value = taskText.textContent;
  editInput.maxLength = 120;
  task.querySelector('.task-content').replaceChild(editInput, taskText);
  editInput.focus();
  editInput.select();
  editInput.addEventListener('input', scheduleAutoSave);

  const finishEditing = () => {
    if (cancelled || !editInput.isConnected) return;
    const newText = editInput.value.trim();
    if (newText) {
      taskText.textContent = capitalizeFirstLetter(newText);
      saveTasksToLocalStorage();
    }
    task.querySelector('.task-content').replaceChild(taskText, editInput);
  };

  editInput.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') finishEditing();
    if (event.key === 'Escape') {
      cancelled = true;
      task.querySelector('.task-content').replaceChild(taskText, editInput);
    }
  });
  editInput.addEventListener('blur', finishEditing);
}

function taskData(task) {
  const textElement = task.querySelector('.task-text');
  const editInput = task.querySelector('.edit-input');
  return {
    text: textElement ? textElement.textContent : (editInput ? editInput.value : ''),
    id: task.dataset.id,
    completed: task.querySelector('.complete-checkbox').checked,
    dueDate: task.dataset.dueDate || '',
    dueTime: task.dataset.dueTime || '09:00',
    priority: task.dataset.priority || 'none'
  };
}

function saveTasksToLocalStorage() {
  const tasks = [...taskList.querySelectorAll('.task')].map(taskData);
  localStorage.setItem('tasks', JSON.stringify(tasks));
  if (window.desktopApp) {
    updateSaveStatus('Saving to this PC…', 'saving');
    return window.desktopApp.saveTasks(tasks).then(() => {
      updateSaveStatus('All changes saved on this PC.');
      return true;
    }).catch((error) => {
      console.error('Unable to save tasks to the desktop app.', error);
      updateSaveStatus('Could not save changes to this PC.', 'error');
      return false;
    });
  }
  updateSaveStatus('All changes saved on this device.');
  return Promise.resolve(true);
}

function loadTasksFromLocalStorage() {
  try {
    const storedTasks = localStorage.getItem('tasks');
    if (storedTasks) {
      const tasks = JSON.parse(storedTasks);
      if (Array.isArray(tasks)) {
        tasks.forEach((task) => {
          if (typeof task.text === 'string') {
            renderTask(
              task.text,
              Boolean(task.completed),
              task.dueDate || '',
              task.dueTime || '09:00',
              task.priority || 'none',
              task.id || createTaskId()
            );
          }
        });
      }
    }
  } catch {
    localStorage.removeItem('tasks');
  }
  updateTaskUi();
}

function updateTaskUi() {
  const taskElements = [...taskList.querySelectorAll('.task')];
  const completedTasks = taskElements.filter((task) => task.classList.contains('completed'));
  const remainingTasks = taskElements.length - completedTasks.length;
  const percentage = taskElements.length ? Math.round((completedTasks.length / taskElements.length) * 100) : 0;

  taskElements.forEach((task) => {
    const completed = task.classList.contains('completed');
    const visible = activeFilter === 'all'
      || (activeFilter === 'active' && !completed)
      || (activeFilter === 'completed' && completed);
    task.hidden = !visible;
  });

  const visibleTasks = taskElements.filter((task) => !task.hidden);
  emptyMessage.hidden = visibleTasks.length !== 0;
  if (visibleTasks.length === 0) {
    if (activeFilter === 'completed') {
      emptyTitle.textContent = 'No completed tasks';
      emptyCopy.textContent = 'Finish a task and it will appear here.';
    } else if (activeFilter === 'active') {
      emptyTitle.textContent = 'Nothing active';
      emptyCopy.textContent = 'Add a task or complete your remaining work.';
    } else {
      emptyTitle.textContent = 'All caught up';
      emptyCopy.textContent = 'Add a task to get started.';
    }
  }
  clearCompletedBtn.hidden = completedTasks.length === 0;
  taskCount.textContent = remainingTasks;
  taskCountLabel.textContent = remainingTasks === 1 ? 'task remaining' : 'tasks remaining';
  progressText.textContent = `${percentage}%`;
  progressRing.style.setProperty('--progress', `${percentage * 3.6}deg`);
  progressRing.setAttribute('aria-label', `${percentage} percent of tasks completed`);
}

function deletePendingTask() {
  if (!pendingDeleteTask) return;
  const nextSibling = pendingDeleteTask.nextElementSibling;
  const removed = taskData(pendingDeleteTask);
  pendingDeleteTask.remove();
  pendingDeleteTask = null;
  saveTasksToLocalStorage();
  updateTaskUi();
  showToast('Task deleted', 'Undo', () => {
    renderTask(removed.text, removed.completed, removed.dueDate, removed.dueTime, removed.priority, removed.id);
    const rendered = taskList.lastElementChild;
    if (nextSibling && nextSibling.isConnected) {
      taskList.insertBefore(rendered, nextSibling);
    }
    saveTasksToLocalStorage();
    updateTaskUi();
  });
}

addTaskBtn.addEventListener('click', addTask);
taskInput.addEventListener('input', scheduleAutoSave);
dueDateInput.addEventListener('input', scheduleAutoSave);
dueTimeInput.addEventListener('input', scheduleAutoSave);
priorityInput.addEventListener('change', scheduleAutoSave);
taskInput.addEventListener('keydown', (event) => {
  if (event.key === 'Enter') addTask();
});

clearCompletedBtn.addEventListener('click', () => {
  const completed = [...taskList.querySelectorAll('.task.completed')];
  const removed = completed.map((task) => ({
    data: taskData(task),
    index: [...taskList.children].indexOf(task)
  }));
  completed.forEach((task) => task.remove());
  saveTasksToLocalStorage();
  updateTaskUi();
  showToast(`${removed.length} completed task${removed.length === 1 ? '' : 's'} cleared`, 'Undo', () => {
    removed.sort((a, b) => a.index - b.index).forEach(({ data, index }) => {
      renderTask(data.text, data.completed, data.dueDate, data.dueTime, data.priority, data.id);
      const rendered = taskList.lastElementChild;
      const before = taskList.children[index];
      if (before && before !== rendered) taskList.insertBefore(rendered, before);
    });
    saveTasksToLocalStorage();
    updateTaskUi();
  });
});

filterButtons.forEach((button) => {
  button.addEventListener('click', () => {
    activeFilter = button.dataset.filter;
    filterButtons.forEach((item) => item.classList.toggle('active', item === button));
    updateTaskUi();
  });
});

confirmDeleteBtn.addEventListener('click', deletePendingTask);

reminderToggle.addEventListener('click', async () => {
  if (window.desktopApp) {
    const enabled = !reminderIsEnabled();
    localStorage.setItem('remindersEnabled', String(enabled));
    try {
      await window.desktopApp.setRemindersEnabled(enabled);
      updateReminderUi();
    } catch (error) {
      console.error('Unable to update desktop reminders.', error);
      localStorage.setItem('remindersEnabled', String(!enabled));
      updateReminderUi();
      reminderStatus.textContent = 'Could not update reminders. Please try again.';
    }
    return;
  }

  if (reminderIsEnabled()) {
    localStorage.setItem('remindersEnabled', 'false');
    clearInterval(reminderTimer);
    updateReminderUi();
    return;
  }

  try {
    const permission = Notification.permission === 'default'
      ? await Notification.requestPermission()
      : Notification.permission;
    if (permission === 'granted') {
      localStorage.setItem('remindersEnabled', 'true');
      updateReminderUi();
      startReminderChecks();
    } else {
      localStorage.setItem('remindersEnabled', 'false');
      updateReminderUi();
      if (permission !== 'denied') reminderStatus.textContent = 'Notification permission was not granted.';
    }
  } catch (error) {
    console.error('Unable to request notification permission.', error);
    reminderStatus.textContent = 'Unable to enable reminders. Check your browser notification settings.';
  }
});

testNotificationBtn.addEventListener('click', async () => {
  if (!window.desktopApp) return;
  testNotificationBtn.disabled = true;
  reminderStatus.textContent = 'Sending a Windows test notification…';
  try {
    const result = await window.desktopApp.sendTestNotification();
    reminderStatus.textContent = result.message;
  } catch (error) {
    console.error('Unable to send a Windows test notification.', error);
    reminderStatus.textContent = 'Could not send a Windows notification. Check Windows notification settings.';
  } finally {
    testNotificationBtn.disabled = false;
  }
});

toastAction.addEventListener('click', () => {
  if (undoAction) undoAction();
  hideToast();
});

function applyTheme(theme) {
  document.documentElement.dataset.theme = theme;
  localStorage.setItem('theme', theme);
  themeToggle.textContent = theme === 'dark' ? '☀' : '☾';
  themeToggle.setAttribute('aria-label', theme === 'dark' ? 'Switch to light mode' : 'Switch to dark mode');
}

themeToggle.addEventListener('click', () => {
  applyTheme(document.documentElement.dataset.theme === 'dark' ? 'light' : 'dark');
});

installBtn.addEventListener('click', async () => {
  if (!deferredInstallPrompt) {
    showToast('Open your browser menu and choose Install app or Add to Home Screen.');
    return;
  }
  await deferredInstallPrompt.prompt();
  await deferredInstallPrompt.userChoice;
  deferredInstallPrompt = null;
});

window.addEventListener('beforeinstallprompt', (event) => {
  event.preventDefault();
  deferredInstallPrompt = event;
});

window.addEventListener('appinstalled', () => {
  deferredInstallPrompt = null;
  showToast('My Tasks was installed.');
});

async function initializeDesktopApp() {
  installBtn.hidden = true;
  const desktopState = await window.desktopApp.getState();

  if (desktopState.hasSavedTasks) {
    taskList.replaceChildren();
    desktopState.tasks.forEach((task) => {
      renderTask(task.text, task.completed, task.dueDate, task.dueTime, task.priority, task.id);
    });
    localStorage.setItem('tasks', JSON.stringify(desktopState.tasks));
  } else {
    await window.desktopApp.saveTasks([...taskList.querySelectorAll('.task')].map(taskData));
  }

  localStorage.setItem('remindersEnabled', String(desktopState.remindersEnabled));
  updateReminderUi();
  window.desktopApp.onRemindersChanged((enabled) => {
    localStorage.setItem('remindersEnabled', String(enabled));
    updateReminderUi();
  });
  window.desktopApp.onNotificationStatus((status) => {
    reminderStatus.textContent = status.message;
  });
}

todayLabel.textContent = new Intl.DateTimeFormat('en', {
  weekday: 'long',
  month: 'long',
  day: 'numeric'
}).format(new Date());

const savedTheme = localStorage.getItem('theme');
applyTheme(savedTheme || (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light'));
document.addEventListener('DOMContentLoaded', () => {
  loadTasksFromLocalStorage();
  loadDraftFromLocalStorage();
  if (window.desktopApp) {
    initializeDesktopApp().catch((error) => {
      console.error('Unable to initialize the desktop app data.', error);
      updateSaveStatus('Desktop app data could not be loaded.', 'error');
    });
  } else {
    updateReminderUi();
    registerServiceWorker();
    startReminderChecks();
  }
});
