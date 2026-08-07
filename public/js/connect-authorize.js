/* Consent page for the hosted MCP connector.
 *
 * Claude.ai / ChatGPT send the user here with the standard OAuth
 * authorization-request parameters. The page:
 *
 *   1. reads them from the QUERY STRING (they are not secrets — the code is
 *      minted later, and PKCE binds it to the client that asked),
 *   2. asks the server for display details, which requires a platform
 *      session (an anonymous visitor is redirected to sign in and comes
 *      straight back here),
 *   3. shows who is asking, the address they will be sent back to, and what
 *      is being allowed, and
 *   4. on an explicit Allow, posts the decision and follows the redirect
 *      the server hands back.
 *
 * The page never mints anything itself and never sees a token.
 */
(function () {
  'use strict';

  var params = new URLSearchParams(window.location.search);
  var request = {
    clientId: params.get('client_id') || '',
    redirectUri: params.get('redirect_uri') || '',
    scope: params.get('scope') || '',
    state: params.get('state') || '',
    codeChallenge: params.get('code_challenge') || '',
    codeChallengeMethod: params.get('code_challenge_method') || '',
    responseType: params.get('response_type') || '',
  };

  var entry = document.getElementById('entry');
  var entryMessage = document.getElementById('entry-message');
  var confirmation = document.getElementById('confirmation');
  var result = document.getElementById('result');
  var message = document.getElementById('message');

  function showEntry(text, isError) {
    entryMessage.textContent = text;
    entryMessage.className = isError ? 'error' : '';
    entry.hidden = false;
    confirmation.hidden = true;
    result.hidden = true;
  }

  function showResult(text, isError) {
    message.textContent = text;
    message.className = isError ? 'error' : '';
    entry.hidden = true;
    confirmation.hidden = true;
    result.hidden = false;
  }

  // One generic message for every failed lookup — a distinguishable
  // "unknown client" vs "bad redirect" would let someone probe which
  // client ids exist.
  var GENERIC_INVALID = 'This connection request is invalid or has expired. Start a new one from Claude or ChatGPT.';

  function looksComplete() {
    return request.clientId
      && request.redirectUri
      && request.codeChallenge
      && request.codeChallengeMethod === 'S256'
      && request.responseType === 'code';
  }

  async function load() {
    if (!looksComplete()) {
      showEntry(
        'Start the connection from Claude or ChatGPT and the approval details will open here automatically.',
        false
      );
      return;
    }

    var query = new URLSearchParams({
      client_id: request.clientId,
      redirect_uri: request.redirectUri,
    });
    if (request.scope) query.set('scope', request.scope);

    var resp;
    try {
      resp = await fetch('/api/connect/authorization?' + query.toString(), {
        credentials: 'same-origin',
        cache: 'no-store',
      });
    } catch (err) {
      showEntry('Could not reach Usernode. Check your connection and reload.', true);
      return;
    }

    if (resp.status === 401) {
      // Sign in, then come back to this exact request.
      window.location.href = '/#login?next='
        + encodeURIComponent(window.location.pathname + window.location.search);
      return;
    }
    if (!resp.ok) {
      showEntry(GENERIC_INVALID, true);
      return;
    }

    var data = await resp.json().catch(function () { return null; });
    if (!data) {
      showEntry(GENERIC_INVALID, true);
      return;
    }

    document.getElementById('intro').textContent =
      data.client_name + ' is asking to connect to your Usernode account.';
    document.getElementById('confirm-client').textContent = data.client_name;
    document.getElementById('confirm-origin').textContent = data.redirect_origin;
    document.getElementById('confirm-user').textContent = data.username;

    var list = document.getElementById('confirm-scopes');
    list.textContent = '';
    (data.scopes || []).forEach(function (scope) {
      var li = document.createElement('li');
      var label = document.createElement('strong');
      label.textContent = scope.label;
      var detail = document.createElement('span');
      detail.textContent = scope.detail;
      li.appendChild(label);
      li.appendChild(detail);
      list.appendChild(li);
    });

    entry.hidden = true;
    confirmation.hidden = false;
  }

  async function decide(decision) {
    var approve = document.getElementById('approve');
    var reject = document.getElementById('reject');
    approve.disabled = true;
    reject.disabled = true;

    var resp;
    try {
      resp = await fetch('/api/connect/oauth/authorize', {
        method: 'POST',
        credentials: 'same-origin',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          decision: decision,
          client_id: request.clientId,
          redirect_uri: request.redirectUri,
          scope: request.scope,
          state: request.state,
          code_challenge: request.codeChallenge,
          code_challenge_method: request.codeChallengeMethod,
        }),
      });
    } catch (err) {
      approve.disabled = false;
      reject.disabled = false;
      showResult('Could not reach Usernode. Try again.', true);
      return;
    }

    if (!resp.ok) {
      approve.disabled = false;
      reject.disabled = false;
      showResult(GENERIC_INVALID, true);
      return;
    }

    var data = await resp.json().catch(function () { return null; });
    if (!data || !data.redirect_to) {
      showResult(GENERIC_INVALID, true);
      return;
    }
    showResult(
      decision === 'approve'
        ? 'Connected. Returning you to your chat…'
        : 'Cancelled. Returning you to your chat…',
      false
    );
    window.location.href = data.redirect_to;
  }

  document.getElementById('approve').addEventListener('click', function () {
    decide('approve');
  });
  document.getElementById('reject').addEventListener('click', function () {
    decide('deny');
  });

  load();
})();
