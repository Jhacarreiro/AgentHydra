"""File-free HTTP phases; the coordinator alone owns locks, dispatch and persistence."""

from copy import deepcopy

from ..errors import ClaudeError
from ..http import valid_uuid
from ..results import brief_result
from .api import ChatGPTClient
from .http import ChatGPTHttp, thread_model, visible_messages


AUTH_HEADERS = frozenset({'authorization', 'user-agent', 'oai-language', 'oai-did', 'chatgpt-account-id'})
BRANCH_FIELDS = ('conversation_id', 'current_node', 'is_temporary_chat')


class ReadOnlyChatGPTHttp(ChatGPTHttp):
    """No phase can dispatch a generation, including an accidental future fallback."""

    def _request(self, method, path, **kwargs):
        if method != 'GET':
            raise ClaudeError('This request phase permits only GET. No additional message was sent.',
                code='phase_mutation_refused')
        return super()._request(method, path, **kwargs)


def _invalid(message):
    raise ClaudeError(message, code='invalid_arguments')


def _headers(headers, *, strict=False):
    if not isinstance(headers, dict) and not hasattr(headers, 'items'):
        _invalid('Phase headers must be a header mapping.')
    allowed = {}
    for key, value in headers.items():
        if not isinstance(key, str) or key.lower() not in AUTH_HEADERS:
            if strict:
                _invalid('Phase headers contain an unsupported field.')
            continue
        if not isinstance(value, str) or '\r' in value or '\n' in value:
            _invalid('Phase headers contain an invalid value.')
        allowed[key] = value
    return allowed


def _branch(body):
    if not isinstance(body, dict) or any(key not in body for key in BRANCH_FIELDS):
        _invalid('A continuation phase requires the compact branch identity.')
    if body['is_temporary_chat'] is not True:
        raise ClaudeError('Temporary Chat is not verified.', code='privacy_not_verified')
    # Malformed branch identities must fail before the coordinator dispatches anything.
    valid_uuid(body['conversation_id'])
    valid_uuid(body['current_node'])
    return {key: body[key] for key in BRANCH_FIELDS}


def _phase(saved_state, timeout, operation, *, http_factory, after_send=False, entry=None, model=None):
    reply = {'ok': False, 'saved_state': deepcopy(saved_state), 'saved_state_valid': True}
    client = None
    try:
        if (not isinstance(saved_state, dict) or not isinstance(saved_state.get('cookies', []), list)
                or not isinstance(saved_state.get('origins', []), list)):
            reply['saved_state_valid'] = False
            _invalid('A phase requires a saved cookie/origin snapshot.')
        if isinstance(timeout, bool) or not isinstance(timeout, int) or timeout < 1:
            _invalid('timeout must be a positive integer.')
        client = (http_factory or ReadOnlyChatGPTHttp)(saved_state, timeout=timeout)
        reply.update(operation(client))
        reply['ok'] = True
    except ClaudeError as error:
        if after_send:
            error = ClaudeError(str(error), code=error.code, status=error.status,
                retryable=error.retryable,
                chat_id=entry.get('chat_id') if isinstance(entry, dict) else None,
                model=model if isinstance(model, str) else None)
        reply['error'] = error.as_dict()
    except Exception:
        reply['error'] = ClaudeError(
            'The sent message could not be confirmed. Do not resend automatically.' if after_send
            else 'The HTTP preflight could not finish. No message was sent.',
            code='stream_interrupted' if after_send else 'operation_failed',
            chat_id=entry.get('chat_id') if isinstance(entry, dict) else None,
            model=model if isinstance(model, str) else None).as_dict()
    finally:
        if client is not None:
            try:
                reply['saved_state'] = client.saved_state()
            except Exception:
                reply['saved_state_valid'] = False
                reply['state_error'] = ClaudeError(
                    'The HTTP operation finished, but rotated login cookies could not be saved. Do not automatically resend a message.',
                    code='session_save_failed').as_dict()
                if reply['ok']:
                    reply['ok'] = False
                    reply['error'] = reply['state_error']
            finally:
                try:
                    client.close()
                except Exception:
                    if reply['ok']:
                        reply['ok'] = False
                        reply['error'] = ClaudeError(
                            'The HTTP connection could not close cleanly. Read the chat before sending again.',
                            code='operation_failed').as_dict()
    return reply


def preflight(saved_state, *, server_id=None, prefer=None, timeout=120, http_factory=None):
    """preflight(saved_state, *, server_id=None, prefer=None, timeout=120, http_factory=None).

    Return ok, saved_state/valid, allowed headers, account_email/label, model,
    existing (the three-field branch or None), and ordered unique previous_ids.
    Failure returns error; state_error marks a snapshot the coordinator must not persist.
    """
    def read(client):
        client.authenticate()
        body = client.read(server_id) if server_id is not None else None
        model = client.model_for(prefer) if body is None else thread_model(body)
        previous = []
        branch = None
        if body is not None:
            messages = visible_messages(body, rich=False)
            identities = [message['id'] for message in messages]
            if any(not isinstance(identity, str) or not identity for identity in identities):
                raise ClaudeError('The selected branch has invalid message identities. No message was sent.',
                    code='invalid_response')
            previous = list(dict.fromkeys(identities))
            branch = _branch(body)
        return {'headers': _headers(client.session.headers), 'account_email': client.account_email,
            'account_label': client.account_label, 'model': model, 'existing': branch,
            'previous_ids': previous}

    return _phase(saved_state, timeout, read, http_factory=http_factory)


def readback(saved_state, *, headers, branch, previous_ids, model, prompt, prepared, entry,
        command, timeout=120, brief=True, http_factory=None):
    """readback(saved_state, *, headers, branch, previous_ids, model, prompt, prepared,
    entry, command, timeout=120, brief=True, http_factory=None).

    Return ok, saved_state/valid and the legacy result envelope. Only already_sent
    browser evidence is accepted; no authenticate, registry/state object or POST occurs.
    """
    def confirm(client):
        if not isinstance(prepared, dict) or prepared.get('already_sent') is not True:
            raise ClaudeError('Readback requires an already completed browser send. No additional message was sent.',
                code='browser_preparation_invalid')
        if command not in {'chat', 'resume'} or not isinstance(brief, bool):
            _invalid('Readback requires chat/resume and a boolean brief flag.')
        if not isinstance(prompt, str) or not prompt.strip():
            _invalid('Supply a nonempty prompt for readback.')
        if (not isinstance(entry, dict) or not isinstance(entry.get('name'), (str, type(None)))
                or 'name' not in entry):
            _invalid('Readback requires the resolved chat_id/name entry.')
        valid_uuid(entry.get('chat_id'))
        existing = _branch(branch) if branch is not None else None
        if command == 'resume' and existing is None:
            _invalid('A resume readback requires its original branch identity.')
        if (not isinstance(previous_ids, list)
                or any(not isinstance(identity, str) or not identity for identity in previous_ids)):
            _invalid('Readback requires a JSON list of previous message identities.')
        if existing is None and previous_ids:
            _invalid('A new-chat readback cannot contain previous message identities.')
        restored = _headers(headers, strict=True)
        authorization = next((value for key, value in restored.items() if key.lower() == 'authorization'), '')
        if not authorization.startswith('Bearer ') or not authorization[7:].strip():
            _invalid('Readback requires the preflight authorization headers.')
        if not isinstance(prepared.get('metrics'), dict):
            _invalid('Readback requires browser preparation measurements.')
        client.session.headers.update(restored)
        client.session.headers.update(_headers(prepared.get('headers', {})))
        body, messages, reply, complete = client.send(prompt, existing=existing, model=model,
            prepared_request=prepared, previous_ids=frozenset(previous_ids))
        value = {'ok': True, 'schema_version': 1, 'provider': 'chatgpt', 'command': command,
            'transport': 'http', **ChatGPTClient._chat_result(entry, body, messages, reply,
                complete, [prepared['metrics']])}
        return {'result': brief_result(value) if brief else value}

    reply = _phase(saved_state, timeout, confirm, http_factory=http_factory,
        after_send=True, entry=entry, model=model)
    if not reply['ok']:
        reply['result'] = {'ok': False, 'error': reply['error']}
    return reply
