(function () {
  const STORAGE_KEY = 'acme.todos';

  const input = document.getElementById('new-todo');
  const addButton = document.getElementById('add-todo');
  const list = document.getElementById('todo-list');
  const emptyMessage = document.getElementById('todo-empty');

  const counterButton = document.getElementById('increment');
  const counterOutput = document.getElementById('count');

  let todos = [];
  try {
    const stored = JSON.parse(localStorage.getItem(STORAGE_KEY) ?? '[]');
    if (Array.isArray(stored)) todos = stored;
  } catch {
    todos = [];
  }

  let count = 0;

  function persist() {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(todos));
  }

  function render() {
    list.replaceChildren();
    for (const todo of todos) {
      const item = document.createElement('li');
      item.className = todo.done ? 'done' : '';
      item.dataset.testid = 'todo-item';

      const label = document.createElement('span');
      label.textContent = todo.text;

      const toggle = document.createElement('button');
      toggle.type = 'button';
      toggle.textContent = todo.done ? 'Undo' : 'Complete';
      toggle.dataset.testid = 'todo-toggle';
      toggle.addEventListener('click', () => {
        todo.done = !todo.done;
        persist();
        render();
      });

      const remove = document.createElement('button');
      remove.type = 'button';
      remove.textContent = 'Delete';
      remove.dataset.testid = 'todo-delete';
      remove.addEventListener('click', () => {
        todos = todos.filter((t) => t !== todo);
        persist();
        render();
      });

      item.append(label, toggle, remove);
      list.append(item);
    }

    emptyMessage.hidden = todos.length > 0;
  }

  function addTodo() {
    const text = input.value.trim();
    if (!text) return;
    todos.push({ text, done: false });
    input.value = '';
    persist();
    render();
  }

  addButton.addEventListener('click', addTodo);
  input.addEventListener('keydown', (event) => {
    if (event.key === 'Enter') addTodo();
  });

  counterButton.addEventListener('click', () => {
    count += 1;
    counterOutput.textContent = String(count);
  });

  render();
})();
