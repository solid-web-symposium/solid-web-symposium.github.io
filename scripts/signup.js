/*
 * Sosy 27 newsletter signup — two paths, no third-party auth deps.
 *
 *   Path "have": user already has a Solid Pod.
 *     → Show static instructions + an example LDN payload + curl command
 *       targeting the organizer inbox. They subscribe themselves.
 *
 *   Path "none": user has no Pod.
 *     → Proof-of-work CAPTCHA (no backend) → create CSS account here →
 *       password login (email used here only) → create Pod with UUID name →
 *       POST a SubscribeAction notification to the organizer inbox with the
 *       new WebID as actor → reveal credentials once.
 *
 * Email handling: stored in the CSS account record (used for password recovery)
 * and included in the notification sent to the organizer's inbox so they can
 * mail you the newsletter. Not written to the subscriber's own Pod.
 */

(() => {
  const SERVER_BASE   = 'https://wiser-solid-xi.interactions.ics.unisg.ch/';
  const ACCOUNT_BASE  = SERVER_BASE + '.account/';
  const ORGANIZER_WEBID = SERVER_BASE + 'sosy27-dokieli/profile/card#me';
  const ORGANIZER_INBOX = SERVER_BASE + 'sosy27-dokieli/inbox/';
  const NEWSLETTER_IRI  = 'https://sosy27.eu/#newsletter';
  const POW_BITS = 20;

  const enc = new TextEncoder();
  const hex = (buf) => [...new Uint8Array(buf)].map(b => b.toString(16).padStart(2, '0')).join('');

  const uuid = () => (crypto.randomUUID ? crypto.randomUUID()
    : ([1e7]+-1e3+-4e3+-8e3+-1e11).replace(/[018]/g, c =>
        (c ^ crypto.getRandomValues(new Uint8Array(1))[0] & 15 >> c / 4).toString(16)));

  const randomPassword = (len = 24) => {
    const alphabet = 'ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789!@#$%^&*-_=+';
    const bytes = crypto.getRandomValues(new Uint32Array(len));
    return [...bytes].map(b => alphabet[b % alphabet.length]).join('');
  };

  async function sha256(str) {
    return hex(await crypto.subtle.digest('SHA-256', enc.encode(str)));
  }

  async function solvePow(challenge, bits, onProgress) {
    const targetHexLen = Math.floor(bits / 4);
    const targetRem = bits % 4;
    let nonce = 0;
    while (true) {
      const digest = await sha256(challenge + ':' + nonce);
      let ok = digest.slice(0, targetHexLen) === '0'.repeat(targetHexLen);
      if (ok && targetRem) {
        const next = parseInt(digest[targetHexLen], 16);
        ok = (next >> (4 - targetRem)) === 0;
      }
      if (ok) return nonce;
      nonce++;
      if (nonce % 2000 === 0) {
        onProgress?.(nonce);
        await new Promise(r => setTimeout(r, 0));
      }
    }
  }

  async function jsonFetch(url, opts = {}) {
    const res = await fetch(url, {
      ...opts,
      headers: { 'Accept': 'application/json', ...(opts.headers || {}) },
    });
    if (!res.ok) {
      let detail = '';
      try { detail = (await res.json()).message || ''; } catch { /* ignore */ }
      throw new Error(`${opts.method || 'GET'} ${url} → ${res.status} ${detail}`);
    }
    return res.json();
  }

  function notificationBody(actorWebId, email) {
    const body = {
      '@context': [
        'https://www.w3.org/ns/activitystreams',
        {
          foaf: 'http://xmlns.com/foaf/0.1/',
          mbox: { '@id': 'foaf:mbox', '@type': '@id' },
        },
      ],
      type: 'Announce',
      actor: actorWebId,
      object: NEWSLETTER_IRI,
      target: ORGANIZER_WEBID,
      published: new Date().toISOString(),
    };
    if (email) body.mbox = `mailto:${email}`;
    return body;
  }

  async function postNotification(actorWebId, email) {
    const res = await fetch(ORGANIZER_INBOX, {
      method: 'POST',
      headers: { 'Content-Type': 'application/ld+json' },
      body: JSON.stringify(notificationBody(actorWebId, email)),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => '');
      console.error('Inbox POST failed', res.status, text);
      throw new Error(`POST ${ORGANIZER_INBOX} → ${res.status}`);
    }
    console.info('Inbox notification stored at', res.headers.get('Location'));
  }

  async function createPodAndSubscribe(email, status) {
    status('Discovering account API…');
    const initial = await jsonFetch(ACCOUNT_BASE);

    status('Creating account…');
    const created = await jsonFetch(initial.controls.account.create, { method: 'POST' });
    const accountToken = created.authorization;
    const authHeader = { 'Authorization': `CSS-Account-Token ${accountToken}` };

    const authed = await jsonFetch(ACCOUNT_BASE, { headers: authHeader });

    const username = uuid();
    const password = randomPassword();

    status('Adding password login…');
    await jsonFetch(authed.controls.password.create, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ email, password }),
    });

    status('Provisioning pod…');
    const pod = await jsonFetch(authed.controls.account.pod, {
      method: 'POST',
      headers: { ...authHeader, 'Content-Type': 'application/json' },
      body: JSON.stringify({ name: username }),
    });
    const podUrl = pod.pod.endsWith('/') ? pod.pod : pod.pod + '/';
    const webId = pod.webId;

    status('Notifying symposium inbox…');
    await postNotification(webId, email);

    return { username, password, webId, podUrl };
  }

  // ---------------------------------------------------------------------------
  // UI

  function paneStatus(pane, msg) {
    let el = pane.querySelector('[data-status]');
    if (!el) {
      el = document.createElement('p');
      el.dataset.status = '';
      el.style.cssText = 'margin:10px 0 0;font-size:13px;opacity:.85';
      pane.appendChild(el);
    }
    el.textContent = msg;
  }

  function paneError(pane, msg) {
    paneStatus(pane, '');
    let el = pane.querySelector('[data-error]');
    if (!el) {
      el = document.createElement('p');
      el.dataset.error = '';
      el.style.cssText = 'margin:10px 0 0;color:#ffd0d0;font-size:13px';
      pane.appendChild(el);
    }
    el.textContent = msg;
  }

  function copyButton(label, text) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      navigator.clipboard?.writeText(text);
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = label; }, 1500);
    });
    return btn;
  }

  function dynamicCopyButton(label, getText) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.textContent = label;
    btn.addEventListener('click', () => {
      navigator.clipboard?.writeText(getText());
      btn.textContent = 'Copied';
      setTimeout(() => { btn.textContent = label; }, 1500);
    });
    return btn;
  }

  function ghostButton(label, onClick) {
    const btn = document.createElement('button');
    btn.type = 'button';
    btn.className = 'ghost';
    btn.textContent = label;
    btn.addEventListener('click', onClick);
    return btn;
  }

  function renderHavePane(root) {
    const pane = document.createElement('div');
    pane.className = 'signup-pane';
    pane.innerHTML = `
      <h3>Subscribe from your existing Solid Pod</h3>
      <p>Send a Linked Data Notification to the symposium inbox using your own
        WebID and email. We'll send the newsletter to you by email — the
        notification just lets us record that you've subscribed.</p>
      <label style="display:block;margin:12px 0 6px;font-size:13px">Your WebID</label>
      <input type="url" data-webid placeholder="https://your.pod.example/profile/card#me"
             style="width:100%;padding:10px 12px;border-radius:8px;border:0;font-size:14px;font-family:'Ubuntu Mono',ui-monospace,monospace" />
      <label style="display:block;margin:12px 0 6px;font-size:13px">Your email address</label>
      <input type="email" data-email required placeholder="you@institution.edu"
             style="width:100%;padding:10px 12px;border-radius:8px;border:0;font-size:14px" />
      <p style="margin-top:14px"><strong>Inbox:</strong> <code>${ORGANIZER_INBOX}</code></p>
      <p style="margin-top:8px"><strong>Notification body to POST as <code>application/ld+json</code>:</strong></p>
      <pre data-payload></pre>
      <p><strong>Example using curl:</strong></p>
      <pre data-curl></pre>
      <p style="margin-top:12px;font-size:12px;opacity:.75">We don't verify the
        <code>actor</code> field — please use your real WebID. Your Pod's auth
        is not required for this POST: the inbox accepts anonymous appends.</p>
      <div class="pane-actions"></div>
    `;
    const payloadEl = pane.querySelector('[data-payload]');
    const curlEl = pane.querySelector('[data-curl]');
    const webidInput = pane.querySelector('[data-webid]');
    const emailInput = pane.querySelector('[data-email]');

    function refresh() {
      const webId = webidInput.value.trim() || 'https://your.pod.example/profile/card#me';
      const email = emailInput.value.trim();
      const body = JSON.stringify(notificationBody(webId, email || null), null, 2);
      payloadEl.textContent = body;
      curlEl.textContent = `curl -X POST '${ORGANIZER_INBOX}' \\
  -H 'Content-Type: application/ld+json' \\
  --data-binary @subscribe.jsonld`;
    }
    webidInput.addEventListener('input', refresh);
    emailInput.addEventListener('input', refresh);
    refresh();

    const actions = pane.querySelector('.pane-actions');
    actions.append(
      dynamicCopyButton('Copy notification', () => payloadEl.textContent),
      dynamicCopyButton('Copy curl command', () => curlEl.textContent),
      ghostButton('Back', () => { pane.remove(); showChooser(root); }),
    );
    root.querySelector('.signup-choice-buttons').style.display = 'none';
    root.appendChild(pane);
  }

  function renderNonePane(root) {
    const pane = document.createElement('div');
    pane.className = 'signup-pane';
    pane.innerHTML = `
      <h3>Create a Solid Pod and subscribe</h3>
      <p>We'll set up a personal Solid Pod for you on University of St.Gallen
        infrastructure (<code>wiser-solid-xi.interactions.ics.unisg.ch</code>).
        It's yours to keep — you can use it with any Solid app.</p>
      <p>The newsletter itself is delivered by email. Your address is stored
        in your Solid account for password recovery and sent to the symposium
        organizers so they can email you issues. Nothing else about you is
        collected.</p>
      <form data-create novalidate>
        <label style="display:block;margin:12px 0 6px;font-size:13px">Email address</label>
        <input type="email" name="email" required placeholder="you@institution.edu"
               style="width:100%;padding:10px 12px;border-radius:8px;border:0;font-size:14px" />
        <div class="pane-actions">
          <button type="submit">Create Pod &amp; subscribe</button>
          <button type="button" class="ghost" data-back>Back</button>
        </div>
      </form>
    `;
    root.querySelector('.signup-choice-buttons').style.display = 'none';
    root.appendChild(pane);

    pane.querySelector('[data-back]').addEventListener('click', () => {
      pane.remove(); showChooser(root);
    });

    pane.querySelector('[data-create]').addEventListener('submit', async (e) => {
      e.preventDefault();
      const input = pane.querySelector('input[type="email"]');
      const email = input.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        paneError(pane, 'Please enter a valid email address.');
        input.focus();
        return;
      }
      const submit = pane.querySelector('button[type="submit"]');
      submit.disabled = true;
      input.disabled = true;
      try {
        paneStatus(pane, 'Solving proof-of-work (security check, may take up to 2 minutes)…');
        await solvePow(email + ':' + Date.now(), POW_BITS,
          n => paneStatus(pane, `Solving proof-of-work… (${n.toLocaleString()} attempts) — this is a security measure and may take up to 2 minutes, please don't close this tab.`));
        const creds = await createPodAndSubscribe(email, msg => paneStatus(pane, msg));
        renderCredentials(pane, creds);
      } catch (err) {
        console.error(err);
        paneError(pane, 'Signup failed: ' + err.message);
        submit.disabled = false;
        input.disabled = false;
      }
    });
  }

  function renderCredentials(pane, creds) {
    const { username, password, webId, podUrl } = creds;
    pane.innerHTML = `
      <h3>Welcome to Solid — you're subscribed!</h3>
      <p>We've recorded your subscription on the symposium's Solid inbox and
        will email you Solid Symposium 2027 updates at the address you
        provided.</p>
      <p>As a bonus, you now have your own personal Solid Pod. It's yours to
        keep and use however you like — store documents, write annotations,
        sign in to other Solid apps, or just explore. The symposium organizers
        have no special access to it.</p>
      <p><strong>Save these credentials now — they're shown only once and we
        cannot recover them.</strong></p>
      <dl style="display:grid;grid-template-columns:max-content 1fr;gap:6px 14px;margin:14px 0;font-family:'Ubuntu Mono',ui-monospace,monospace;font-size:13px;word-break:break-all">
        <dt>WebID</dt><dd><a href="${webId}" target="_blank" rel="noopener" style="color:#fff;text-decoration:underline">${webId}</a></dd>
        <dt>Pod</dt><dd><a href="${podUrl}README" target="_blank" rel="noopener" style="color:#fff;text-decoration:underline">${podUrl}README</a></dd>
        <dt>Username</dt><dd>${username}</dd>
        <dt>Password</dt><dd>${password}</dd>
      </dl>
      <div class="pane-actions"></div>
      <p style="margin-top:12px;font-size:12px;opacity:.75">Your Pod is hosted
        on University of St.Gallen infrastructure
        (<code>wiser-solid-xi.interactions.ics.unisg.ch</code>). Sign in any
        time at
        <a href="https://wiser-solid-xi.interactions.ics.unisg.ch/.account/login/password/" target="_blank" rel="noopener">the login page</a>
        — if you forget your password, the email you provided will be used for
        recovery.</p>
    `;
    const text = `WebID: ${webId}\nPod: ${podUrl}README\nUsername: ${username}\nPassword: ${password}\n`;
    pane.querySelector('.pane-actions').appendChild(copyButton('Copy credentials', text));
  }

  function renderEmailPane(root) {
    const pane = document.createElement('div');
    pane.className = 'signup-pane';
    pane.innerHTML = `
      <h3>Email-only newsletter signup</h3>
      <p>If you'd rather not deal with Solid right now, just leave us your
        email and we'll send the newsletter the old-fashioned way. Your address
        is handled by <a href="https://formspree.io/" target="_blank" rel="noopener" style="color:#fff;text-decoration:underline">Formspree</a>
        and forwarded to the symposium organizers.</p>
      <form data-formspree novalidate
            action="https://formspree.io/f/mqenkgjn" method="post">
        <label style="display:block;margin:12px 0 6px;font-size:13px">Email address</label>
        <input type="email" name="email" required placeholder="you@institution.edu"
               style="width:100%;padding:10px 12px;border-radius:8px;border:0;font-size:14px" />
        <input type="hidden" name="_subject" value="New Sosy 27 newsletter signup" />
        <div style="position:absolute;left:-5000px" aria-hidden="true">
          <label>Leave this empty<input type="text" name="_gotcha" tabindex="-1" autocomplete="off" value="" /></label>
        </div>
        <div class="pane-actions">
          <button type="submit">Notify me</button>
          <button type="button" class="ghost" data-back>Back</button>
        </div>
      </form>
    `;
    root.querySelector('.signup-choice-buttons').style.display = 'none';
    root.appendChild(pane);

    pane.querySelector('[data-back]').addEventListener('click', () => {
      pane.remove(); showChooser(root);
    });

    pane.querySelector('[data-formspree]').addEventListener('submit', async (e) => {
      e.preventDefault();
      const form = e.currentTarget;
      const input = form.querySelector('input[type="email"]');
      const email = input.value.trim();
      if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
        paneError(pane, 'Please enter a valid email address.');
        input.focus();
        return;
      }
      const submit = form.querySelector('button[type="submit"]');
      const body = new FormData(form);
      submit.disabled = true;
      input.disabled = true;
      try {
        paneStatus(pane, 'Sending…');
        const res = await fetch(form.action, {
          method: 'POST',
          headers: { 'Accept': 'application/json' },
          body,
        });
        if (!res.ok) {
          const data = await res.json().catch(() => ({}));
          const msg = data.errors?.[0]?.message || 'Something went wrong. Please try again.';
          throw new Error(msg);
        }
        renderEmailSuccess(pane, email);
      } catch (err) {
        console.error(err);
        paneError(pane, err.message || 'Network error. Please email info@sosy27.eu instead.');
        submit.disabled = false;
        input.disabled = false;
      }
    });
  }

  function renderEmailSuccess(pane, email) {
    pane.innerHTML = `
      <h3>You're on the list</h3>
      <p>We've recorded <code>${email}</code> and will email you about Solid
        Symposium 2027. No Solid Pod was created for you.</p>
    `;
  }

  function showChooser(root) {
    root.querySelector('.signup-choice-buttons').style.display = '';
  }

  // Symposium starts 2027-05-11 09:00 local time in St.Gallen (CEST, UTC+02:00).
  const TARGET_MS = Date.parse('2027-05-11T09:00:00+02:00');

  function startCountdown() {
    const cells = {
      d: document.querySelector('[data-cd="d"]'),
      h: document.querySelector('[data-cd="h"]'),
      m: document.querySelector('[data-cd="m"]'),
      s: document.querySelector('[data-cd="s"]'),
    };
    if (!cells.d || !cells.h || !cells.m || !cells.s) return;

    const pad = (n, w = 2) => String(Math.max(0, n)).padStart(w, '0');

    const tick = () => {
      const diff = TARGET_MS - Date.now();
      if (diff <= 0) {
        cells.d.textContent = '0';
        cells.h.textContent = cells.m.textContent = cells.s.textContent = '00';
        return false;
      }
      const totalSec = Math.floor(diff / 1000);
      cells.d.textContent = String(Math.floor(totalSec / 86400));
      cells.h.textContent = pad(Math.floor((totalSec % 86400) / 3600));
      cells.m.textContent = pad(Math.floor((totalSec % 3600) / 60));
      cells.s.textContent = pad(totalSec % 60);
      return true;
    };

    if (tick()) {
      const id = setInterval(() => { if (!tick()) clearInterval(id); }, 1000);
    }
  }

  function init() {
    document.querySelectorAll('[data-signup-root]').forEach(root => {
      root.addEventListener('click', (e) => {
        const btn = e.target.closest('[data-signup-path]');
        if (!btn) return;
        const path = btn.dataset.signupPath;
        if (path === 'have') renderHavePane(root);
        else if (path === 'none') renderNonePane(root);
        else if (path === 'email') renderEmailPane(root);
      });
    });

    // Legacy form (if still present) becomes a no-op since the chooser
    // replaces it. Just disable the submit so it can't accidentally POST.
    document.querySelectorAll('form.signup-form').forEach(form => {
      form.style.display = 'none';
    });

    startCountdown();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
