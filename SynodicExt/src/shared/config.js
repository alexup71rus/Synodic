/** Настройка сервера задаётся пользователем и хранится только в storage.local. */
globalThis.SynodicConfig = Object.freeze({
  STORAGE_KEY: 'serverUrl',
  normalizeServerUrl(value) {
    const input = typeof value === 'string' ? value.trim() : '';
    if (!input) throw new Error('Укажите адрес сервера Synodic');
    let url;
    try { url = new URL(input); } catch {
      throw new Error('Введите полный адрес, например https://synodic.example.com');
    }
    if (!/^https?:\/\//i.test(input) || !['http:', 'https:'].includes(url.protocol)) {
      throw new Error('Адрес должен начинаться с http:// или https://');
    }
    if (url.username || url.password || /^https?:\/\/[^/?#]*@/i.test(input)) {
      throw new Error('Адрес сервера не должен содержать логин или пароль');
    }
    if (input.includes('?') || input.includes('#')) {
      throw new Error('Укажите адрес сервера без параметров и фрагмента (#)');
    }
    if (/\s|\\/.test(input)) throw new Error('Адрес не должен содержать пробелы или обратную косую черту');
    return url.href.replace(/\/+$/, '');
  },
  endpoint(serverUrl, path) {
    return new URL(path, `${serverUrl}/`);
  },
});
