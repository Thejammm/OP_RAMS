// Shared fetch helper. All requests include the session cookie.
(function () {
  const base = () => window.API_BASE || '';

  async function request(method, path, body) {
    const res = await fetch(base() + path, {
      method,
      credentials: 'include',
      headers: body ? { 'Content-Type': 'application/json' } : {},
      body: body ? JSON.stringify(body) : undefined,
    });
    // 401 anywhere means kick to login.
    if (res.status === 401 && !path.startsWith('/auth/login')) {
      // Avoid redirect loop when already on the login page
      const page = window.location.pathname.split('/').pop();
      if (page && page !== 'index.html' && page !== '') {
        window.location.href = 'index.html';
      }
      throw new Error('unauthenticated');
    }
    const text = await res.text();
    const data = text ? JSON.parse(text) : null;
    if (!res.ok) {
      const msg = data?.error?.message || `Request failed (${res.status})`;
      const err = new Error(msg);
      err.status = res.status;
      err.code = data?.error?.code;
      throw err;
    }
    return data;
  }

  window.api = {
    login:   (email, password) => request('POST', '/auth/login', { email, password }),
    logout:  () => request('POST', '/auth/logout'),
    me:      () => request('GET', '/auth/me'),

    listAssessments:   () => request('GET', '/assessments'),
    getAssessment:     (id) => request('GET', `/assessments/${encodeURIComponent(id)}`),
    createAssessment:  (name, state) => request('POST', '/assessments', { name, state }),
    updateAssessment:  (id, patch) => request('PATCH', `/assessments/${encodeURIComponent(id)}`, patch),
    deleteAssessment:  (id) => request('DELETE', `/assessments/${encodeURIComponent(id)}`),

    // admin
    listUsers:       () => request('GET', '/admin/users'),
    createUser:      (data) => request('POST', '/admin/users', data),
    updateUser:      (id, patch) => request('PATCH', `/admin/users/${encodeURIComponent(id)}`, patch),
    revokeSessions:  (id) => request('POST', `/admin/users/${encodeURIComponent(id)}/revoke-sessions`),
    deactivateUser:  (id) => request('DELETE', `/admin/users/${encodeURIComponent(id)}`),
  };
})();
