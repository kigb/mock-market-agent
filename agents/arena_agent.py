"""Tiny, dependency-free MCP trading client and reusable agent classes.

Market operations use MCP, with an explicit REST mode for hosted clients without platform OAuth. Model keys are read
from environment variables by the CLI and never sent to arena tools.
"""
from __future__ import annotations
import json
import itertools
import os
import ssl
import time
import uuid
import random
from urllib.request import Request, urlopen
from urllib.error import HTTPError, URLError
from typing import Any

def verified_tls_context():
    context = ssl.create_default_context()
    # Some python.org macOS installs have no CA bundle until their separate
    # certificate installer is run. Use an existing OS CA bundle, never an
    # unverified context, and respect explicit trust-store environment settings.
    if not context.get_ca_certs() and not (os.getenv('SSL_CERT_FILE') or os.getenv('SSL_CERT_DIR')):
        for bundle in ('/etc/ssl/cert.pem', '/etc/ssl/certs/ca-certificates.crt', '/etc/pki/tls/certs/ca-bundle.crt'):
            if os.path.isfile(bundle):
                context.load_verify_locations(cafile=bundle)
                break
    return context

TLS_CONTEXT = verified_tls_context()

class MCPError(RuntimeError):
    pass

class MCPAuthenticationRequired(MCPError):
    pass

class ArenaMCP:
    def __init__(self, arena_url: str, service_token: str | None = None,
                 mcp_token: str | None = None, transport: str = 'auto'):
        if transport not in ('auto', 'mcp', 'rest'):
            raise ValueError('Transport must be auto, mcp, or rest.')
        self.origin = arena_url.rstrip('/')
        self.endpoint = self.origin + '/mcp'
        self.service_token, self.mcp_token = service_token, mcp_token
        self.transport = 'rest' if transport == 'rest' else 'mcp'
        self._ids = itertools.count(1)
        if self.transport == 'mcp':
            try:
                self.rpc('initialize', {'protocolVersion': '2025-06-18', 'capabilities': {},
                         'clientInfo': {'name': 'arena-python-starter', 'version': '2.0.0'}})
            except MCPAuthenticationRequired:
                if transport != 'auto':
                    raise
                self.transport = 'rest'
                print('Hosted MCP requires platform authentication; using public REST with arena tokens.')

    def rpc(self, method: str, params: dict | None = None) -> Any:
        headers = {'Content-Type': 'application/json', 'User-Agent': 'MarketArenaAgent/2.0', 'Accept': 'application/json, text/event-stream',
                   'MCP-Protocol-Version': '2025-06-18'}
        if self.mcp_token:
            headers['Authorization'] = 'Bearer ' + self.mcp_token
        if self.service_token:
            headers['OAI-Sites-Authorization'] = 'Bearer ' + self.service_token
        payload = {'jsonrpc': '2.0', 'id': next(self._ids), 'method': method, 'params': params or {}}
        request = Request(self.endpoint, json.dumps(payload).encode(), headers, method='POST')
        try:
            with urlopen(request, timeout=15, context=TLS_CONTEXT) as response:
                envelope = json.load(response)
        except HTTPError as exc:
            if exc.code == 401:
                raise MCPAuthenticationRequired('Native MCP requires platform OAuth. Set ARENA_MCP_TOKEN to a valid OAuth access token, or select --transport rest.') from None
            raise MCPError(f'Arena HTTP {exc.code}; check URL and site access.') from None
        except (URLError, TimeoutError) as exc:
            raise MCPError(f'Arena connection failed: {type(exc).__name__}') from None
        if 'error' in envelope:
            raise MCPError(envelope['error'].get('message', 'MCP error'))
        return envelope['result']

    def tools(self) -> list[dict]:
        if self.transport == 'rest':
            return self._rest('tools')['tools']
        return self.rpc('tools/list')['tools']

    def call_tool(self, name: str, arguments: dict | None = None) -> Any:
        if self.transport == 'rest':
            return self._rest_tool(name, arguments or {})
        response = self.rpc('tools/call', {'name': name, 'arguments': arguments or {}})
        text = '\n'.join(c.get('text', '') for c in response.get('content', []) if c.get('type') == 'text')
        if response.get('isError'):
            raise MCPError(text or 'Arena tool failed')
        return response.get('structuredContent', json.loads(text) if text else {})

    def _rest(self, path: str, method: str = 'GET', body: dict | None = None, token: str | None = None):
        headers = {'Content-Type': 'application/json', 'User-Agent': 'MarketArenaAgent/2.0'}
        if token:
            headers['X-Arena-Token'] = token
        if self.service_token:
            headers['OAI-Sites-Authorization'] = 'Bearer ' + self.service_token
        request = Request(self.origin+'/api/arena/'+path,
                          json.dumps(body).encode() if body is not None else None, headers, method=method)
        try:
            with urlopen(request, timeout=15, context=TLS_CONTEXT) as response:
                return json.load(response)
        except HTTPError as exc:
            try:
                message = json.load(exc).get('error', 'Arena request failed')
            except (ValueError, AttributeError):
                message = f'Arena HTTP {exc.code}; check site access.'
            raise MCPError(message) from None
        except (URLError, TimeoutError) as exc:
            raise MCPError(f'Arena connection failed: {type(exc).__name__}') from None

    def _rest_text(self, path: str, token: str | None = None) -> str:
        """GET a text resource such as the round log (text/markdown)."""
        headers = {'Accept': 'text/markdown, text/plain', 'User-Agent': 'MarketArenaAgent/2.0'}
        if token:
            headers['X-Arena-Token'] = token
        if self.service_token:
            headers['OAI-Sites-Authorization'] = 'Bearer ' + self.service_token
        try:
            with urlopen(Request(self.origin+'/api/arena/'+path, None, headers), timeout=30, context=TLS_CONTEXT) as response:
                return response.read().decode('utf-8', errors='replace')
        except HTTPError as exc:
            raise MCPError(f'Arena HTTP {exc.code} fetching {path}.') from None
        except (URLError, TimeoutError) as exc:
            raise MCPError(f'Arena connection failed: {type(exc).__name__}') from None

    def _rest_tool(self, name: str, a: dict):
        if name == 'get_rules':
            return self._rest('rules')
        if name == 'create_game':
            body = {'seed': a.get('seed', 42), 'agents': []}
            if a.get('durationSeconds') is not None:
                body['durationSeconds'] = a['durationSeconds']
            return self._rest('games', 'POST', body)
        game = 'games/' + a.get('gameId', '')
        token = a.get('agentToken')
        if name == 'register_agent':
            return self._rest(game+'/agents', 'POST', {'name': a['name']}, a.get('hostToken'))
        if name == 'start_game':
            return self._rest(game+'/start', 'POST', {}, a.get('hostToken'))
        if name in ('get_order_book', 'get_position'):
            data = self._rest(game+'/book', token=token)
            if name == 'get_position':
                data['result'] = {k: data['result'][k] for k in ('position', 'openOrders')}
            return data
        if name == 'get_results':
            return self._rest(game+'/results', token=a.get('token'))
        if name == 'wait':
            return {'result': {'status': 'waiting'}}
        routes = {'place_order': 'orders', 'cancel_order': 'cancel', 'cancel_all': 'cancel', 'record_decision': 'metrics'}
        if name not in routes:
            raise MCPError('Unknown arena tool: ' + name)
        payload = {k: v for k, v in a.items() if k not in ('gameId', 'agentToken')}
        return self._rest(game+'/'+routes[name], 'POST', payload, token)

class BaseAgent:
    """Override decide(). Identity and transport stay outside your strategy."""
    def __init__(self, mcp: ArenaMCP, game_id: str, agent_token: str, interval: float = 0.0):
        self.mcp, self.game_id, self.agent_token = mcp, game_id, agent_token
        # 0 = free-running: the next decision starts as soon as this one lands, with a 250 ms floor.
        self.interval = max(0.0, interval)
        # This strategy chooses its own initial quote; the exchange provides none.
        self.opening_quote = random.SystemRandom().randrange(10001) / 100
        self.rules = mcp.call_tool('get_rules')
        self.errors: list[str] = []
        self.last_usage = {'prompt_tokens': 0, 'completion_tokens': 0}
        # One or two sentences explaining the latest decision; reported with record_decision for the round log.
        self.last_note = ''

    def call(self, name: str, **arguments) -> Any:
        return self.mcp.call_tool(name, {**arguments, 'gameId': self.game_id, 'agentToken': self.agent_token})

    def observe(self) -> dict:
        return self.call('get_order_book')['result']

    def decide(self, observation: dict) -> list[dict]:
        return [{'action': 'wait'}]

    def followup(self, observation: dict) -> list[dict]:
        return self.decide(observation)

    def feedback(self, actions: list[dict], results: list[dict]) -> None:
        pass

    def error_notice(self, message: str) -> None:
        pass

    def run(self) -> None:
        while True:
            started = time.monotonic()
            try:
                observed = self.observe()
                if observed['status'] == 'finished':
                    return
                if observed['status'] == 'lobby':
                    time.sleep(.25)
                    continue
                self.turn_deadline = time.monotonic() + min(65, observed['remainingMs']/1000)
                budget = 4
                # Server-clock stamp of the snapshot this decision acts on. A follow-up turn acts on the
                # previous turn's tool results, so its observation time is that turn's execution time.
                observation_time = observed.get('serverTime')
                for turn in range(2):
                    if time.monotonic() >= self.turn_deadline:
                        break
                    inference_started = time.monotonic()
                    actions = self.decide(observed) if turn == 0 else self.followup(observed)
                    response_time = round(time.time()*1000)
                    latency = round((time.monotonic()-inference_started)*1000)
                    results, ended, execution_time = [], False, None
                    for i, action in enumerate(actions):
                        item = dict(action)
                        name = item.pop('action')
                        if i >= budget or ended:
                            results.append({'ok': False, 'error': 'Decision budget or game deadline reached; not executed.'})
                            continue
                        if name in ('place_order', 'cancel_order', 'cancel_all'):
                            item.setdefault('requestId', str(uuid.uuid4()))
                        try:
                            response = self.call(name, **item)
                            results.append({'ok': True, 'result': response.get('result', response)})
                            # state.now is the server time at which the arena applied this action.
                            state_now = (response.get('state') or {}).get('now') if isinstance(response, dict) else None
                            if isinstance(state_now, (int, float)):
                                execution_time = max(execution_time or 0, state_now)
                        except MCPError as exc:
                            results.append({'ok': False, 'error': str(exc)})
                            self.errors.append(str(exc))
                            ended = 'ended' in str(exc)
                    self.feedback(actions, results)
                    if ended:
                        return
                    # Optional telemetry follows trading so a telemetry error cannot discard a chosen action.
                    # observationTime and executionTime are server stamps, so staleness is clock-consistent;
                    # responseTime is this machine's clock when the model replied.
                    self.call('record_decision', latencyMs=latency,
                              inputTokens=self.last_usage.get('prompt_tokens', 0),
                              outputTokens=self.last_usage.get('completion_tokens', 0),
                              observationTime=observation_time, responseTime=response_time, executionTime=execution_time,
                              round=turn, model=getattr(self, 'model', None),
                              reasoningEffort=getattr(self, 'reasoning_effort', None) or None,
                              actions=[summarize_action(a, r) for a, r in zip(actions, results)],
                              note=(self.last_note or '')[:600] or None,
                              reasoning=(getattr(self, 'last_reasoning', '') or '')[:100000] or None, requestId=str(uuid.uuid4()))
                    observation_time = execution_time or observation_time
                    budget -= min(budget, len(actions))
                    if not actions or budget == 0 or any(a['action'] not in ('get_rules', 'get_order_book', 'get_position') for a in actions):
                        break
            except (MCPError, ValueError) as exc:
                self.error_notice(str(exc))
                if 'ended' in str(exc):
                    return
                self.errors.append(str(exc))
                print(f'{type(self).__name__}: {exc}')
                if len(self.errors) >= 5:
                    print(f'{type(self).__name__}: stopped after five errors.')
                    return
            time.sleep(max(.25, self.interval - (time.monotonic() - started)))

def lean_snapshot(value):
    """Model-facing view of an observation (or a tool result wrapping one): no static rules, the trading view of the
    account only, compact orders and fills, every Atlas execution so far is kept. The full data stays in the arena."""
    if isinstance(value, dict) and 'book' in value:
        me = (value.get('position') or {}).get('id')
        who = lambda ident: 'Atlas' if ident == '$atlas' else 'you' if ident == me else 'other'
        lean = {k: v for k, v in value.items() if k not in ('rules', 'position', 'openOrders', 'recentFills')}
        pos = value.get('position')
        if isinstance(pos, dict):
            lean['position'] = {k: pos.get(k) for k in ('position', 'cash', 'pnl', 'realizedPnl', 'unrealizedPnl', 'averageEntry')}
        if isinstance(value.get('openOrders'), list):
            lean['openOrders'] = [{k: o.get(k) for k in ('id', 'side', 'price', 'quantity')} for o in value['openOrders']]
        if isinstance(value.get('recentFills'), list):
            lean['recentFills'] = [{'time': f.get('time'), 'side': f.get('side'), 'price': f.get('price'), 'quantity': f.get('quantity'),
                                    'taker': who(f.get('taker')), 'maker': who(f.get('maker'))} for f in value['recentFills']]
        return lean
    if isinstance(value, dict) and isinstance(value.get('result'), dict):
        result = value['result']
        if 'filledQuantity' in result:
            lean = {'orderId': result.get('orderId'), 'status': result.get('status'), 'filled': result.get('filledQuantity')}
            if result.get('filledQuantity'):
                lean['averageFillPrice'] = result.get('averageFillPrice')
            if result.get('remainingQuantity'):
                lean['resting'] = result['remainingQuantity']
            return {**value, 'result': lean}
        return {**value, 'result': lean_snapshot(result)}
    return value

def summarize_action(action: dict, outcome: dict) -> dict:
    """Credential-free per-action summary for record_decision: what was asked and what the arena did."""
    summary = {k: action[k] for k in ('action', 'side', 'type', 'quantity', 'price') if action.get(k) is not None}
    summary['ok'] = bool(outcome.get('ok'))
    result = outcome.get('result') if summary['ok'] else None
    if isinstance(result, dict):
        summary.update({k: result[k] for k in ('status', 'filledQuantity', 'orderId') if k in result})
    elif outcome.get('error'):
        summary['error'] = str(outcome['error'])[:200]
    return summary

def quote(side: str, price: float, quantity: int = 5) -> dict:
    return {'action': 'place_order', 'side': side, 'type': 'limit',
            'quantity': quantity, 'price': round(max(0, min(100, price)), 2)}

def market_reference(o: dict, own_quote: float) -> float:
    if o['lastPrice'] is not None:
        return o['lastPrice']
    bid, ask = o['book']['bestBid'], o['book']['bestAsk']
    if bid is not None and ask is not None:
        return (bid + ask) / 2
    return bid if bid is not None else ask if ask is not None else own_quote

class MarketMakerAgent(BaseAgent):
    def decide(self, o: dict) -> list[dict]:
        reference = market_reference(o, self.opening_quote)
        skew = max(-.15, min(.15, o['position']['position'] * .002))
        self.last_note = f'Reference {reference:.2f} from {"last trade" if o["lastPrice"] is not None else "the book or my opening guess"}; inventory {o["position"]["position"]:+d} so skew {-skew:+.2f}; requoting both sides 0.04 away.'
        return [{'action': 'cancel_all'}, quote('buy', reference-.04-skew),
                quote('sell', reference+.04-skew)]

class MeanReversionAgent(BaseAgent):
    def decide(self, o: dict) -> list[dict]:
        recent = o['recentFills']
        quantity = sum(f['quantity'] for f in recent)
        anchor = sum(f['price']*f['quantity'] for f in recent)/quantity if quantity else market_reference(o, self.opening_quote)
        bid, ask = o['book']['bestBid'], o['book']['bestAsk']
        actions = [{'action': 'cancel_all'}]
        self.last_note = f'Anchor {anchor:.2f} from the last {len(recent)} fills; ask {ask} / bid {bid}; ' + ('lifting the cheap ask.' if ask is not None and ask < anchor else 'hitting the rich bid.' if bid is not None and bid > anchor else 'quoting 0.02 around the anchor.')
        if ask is not None and ask < anchor:
            return actions + [{'action': 'place_order', 'side': 'buy', 'type': 'market', 'quantity': 3}]
        if bid is not None and bid > anchor:
            return actions + [{'action': 'place_order', 'side': 'sell', 'type': 'market', 'quantity': 3}]
        return actions + [quote('buy', anchor-.02, 3), quote('sell', anchor+.02, 3)]

class MomentumAgent(BaseAgent):
    def decide(self, o: dict) -> list[dict]:
        recent = o['recentFills']
        up = len(recent) < 2 or recent[0]['price'] >= recent[1]['price']
        side, best = ('buy', o['book']['bestAsk']) if up else ('sell', o['book']['bestBid'])
        self.last_note = f'Last move {"up" if up else "down"} ({len(recent)} recent fills); ' + (f'taking the {side} side at {best}.' if best is not None else 'no quote to take, posting 0.05 around the reference.')
        if best is not None:
            return [{'action': 'place_order', 'side': side, 'type': 'market', 'quantity': 2}]
        reference = market_reference(o, self.opening_quote)
        return [{'action': 'cancel_all'}, quote('buy', reference-.05, 3),
                quote('sell', reference+.05, 3)]

class ModelAgent(BaseAgent):
    """A provider-backed agent that executes its chosen tools through real MCP.

    API compatibility: OpenAI-style /chat/completions with function tools.
    The actual underlying model must support tool calling.
    """
    def __init__(self, *args, provider: str, model: str, api_key: str, base_url: str = '',
                 temperature: float = .3, max_tokens: int = 512, prompt: str = '', reasoning_effort: str = '', **kwargs):
        super().__init__(*args, **kwargs)
        # Sail accepts OpenAI-style reasoning_effort (none/low/medium/high); it is recorded with every decision.
        self.reasoning_effort = reasoning_effort if provider == 'sail' else ''
        endpoints = {'fireworks': 'https://api.fireworks.ai/inference/v1',
                     'sail': 'https://api.sailresearch.com/v1', 'modal': base_url}
        if provider not in endpoints or not endpoints[provider]:
            raise ValueError('Choose fireworks, sail, or modal (Modal requires base_url).')
        self.url = endpoints[provider].rstrip('/') + '/chat/completions'
        self.api_key, self.model = api_key, model
        self.provider = provider
        self.temperature, self.max_tokens, self.prompt = temperature, max_tokens, prompt
        self.history: list[dict] = []
        self.trajectory: list[dict] = []
        self.pending_calls: list[dict] = []
        names = {'get_rules', 'get_order_book', 'get_position', 'place_order', 'cancel_order', 'cancel_all', 'wait'}
        self.model_tools = []
        for tool in self.mcp.tools():
            if tool['name'] not in names:
                continue
            schema = json.loads(json.dumps(tool['inputSchema']))
            schema['properties'].pop('gameId', None)
            schema['properties'].pop('agentToken', None)
            schema['required'] = [x for x in schema.get('required', []) if x not in ('gameId', 'agentToken')]
            self.model_tools.append({'type': 'function', 'function': {'name': tool['name'],
                                    'description': tool['description'], 'parameters': schema}})

    def remember(self, message: dict) -> None:
        def clean(value, field=''):
            if isinstance(value, str):
                if field not in ('role', 'type'):
                    for secret in (self.api_key, self.agent_token):
                        if secret:
                            value = value.replace(secret, '[redacted]')
                return value
            if isinstance(value, list):
                return [clean(v) for v in value]
            if isinstance(value, dict):
                return {k: clean(v, k) for k, v in value.items()}
            return value
        safe = clean(message)
        self.history.append(safe)
        self.trajectory.append({'time': round(time.time()*1000), 'message': safe})

    def error_notice(self, message: str) -> None:
        self.remember({'role': 'user', 'content': json.dumps({'kind': 'error', 'error': message})})

    def feedback(self, actions: list[dict], results: list[dict]) -> None:
        for call, result in zip(self.pending_calls, results):
            self.remember({'role': 'tool', 'tool_call_id': call['id'], 'content': json.dumps(lean_snapshot(result))})
        self.pending_calls = []

    def decide(self, o: dict) -> list[dict]:
        return self.infer(o, fresh=True)

    def followup(self, o: dict) -> list[dict]:
        return self.infer(o, fresh=False)

    def infer(self, o: dict, fresh: bool) -> list[dict]:
        if fresh:
            # The static rules go into the system prompt once; dropping them from each snapshot roughly halves history growth.
            self.remember({'role': 'user', 'content': json.dumps(lean_snapshot(o))})
        headers = {'Content-Type': 'application/json', 'User-Agent': 'MarketArenaAgent/3.0'}
        if self.api_key:
            headers['Authorization'] = 'Bearer ' + self.api_key
        system = ('Compete in this timed trading arena; the rules give durationSeconds and every snapshot gives remainingMs. Maximize final total P&L: cash plus inventory valued at C, the hidden Atlas center revealed at the end. '
                  'Quotes cannot move C. Infer it from where Atlas trades; no opening price is supplied. '
                  'Your entire conversation from this round is retained. Use earlier actions and their tool results to adapt. The latest snapshot includes your current orders and position. '
                  'Begin every reply with one or two plain sentences saying what you see and why you act (they are logged), then call the tools in the same reply. Use at most four trading tools per decision. All prices are dollars. Supply quotes when needed. Read the public Atlas mechanism: random arrivals, limit price within C ± 5, quantity cap. Rules: '
                  + json.dumps(o.get('rules', self.rules)) + '\nStrategy: ' + self.prompt)
        payload = {'model': self.model, 'messages': [{'role': 'system', 'content': system}, *self.history],
                   'tools': self.model_tools, 'tool_choice': 'auto', 'temperature': self.temperature, 'stream': False}
        payload['max_completion_tokens' if self.provider == 'sail' else 'max_tokens'] = self.max_tokens
        if self.reasoning_effort:
            payload['reasoning_effort'] = self.reasoning_effort
        timeout = max(.1, min(60, o['remainingMs']/1000,
                             getattr(self, 'turn_deadline', time.monotonic()+60)-time.monotonic()))
        try:
            with urlopen(Request(self.url, json.dumps(payload).encode(), headers, method='POST'), timeout=timeout, context=TLS_CONTEXT) as r:
                data = json.load(r)
                message = data['choices'][0]['message']
                self.last_usage = data.get('usage', {})
        except HTTPError as exc:
            if exc.code == 400:
                detail = exc.read(256000).decode(errors='replace')
                if any(marker in detail.lower() for marker in ('context_length_exceeded', 'exceeds safe limit', 'maximum context')):
                    raise MCPError('Provider context window exceeded. Full history is retained; choose a model with a larger context window.') from None
            raise MCPError(f'Model provider HTTP {exc.code}; check key, model, and quota.') from None
        except (URLError, TimeoutError, KeyError) as exc:
            raise MCPError(f'Model request failed: {type(exc).__name__}') from None
        calls = message.get('tool_calls') or []
        if not calls and isinstance(message.get('content'), str):
            text = message['content'].strip()
            if text.startswith('```'):
                text = text.split('\n', 1)[-1].rsplit('```', 1)[0].strip()
            try:
                decoded = json.loads(text)
                items = decoded if isinstance(decoded, list) else decoded.get('actions', [decoded])
                calls = [{'id': 'call_'+str(uuid.uuid4()), 'type': 'function',
                          'function': {'name': item.get('action', item.get('name')),
                                       'arguments': json.dumps({k: v for k, v in item.items() if k not in ('action', 'name')})}}
                         for item in items if isinstance(item, dict) and (item.get('action') or item.get('name'))]
            except (ValueError, AttributeError):
                pass
        if len(calls) > 16:
            raise MCPError('Model returned too many tool calls.')
        normalized, actions, used = [], [], set()
        for call in calls:
            identifier = call.get('id') or 'call_'+str(uuid.uuid4())
            if identifier in used:
                identifier = 'call_'+str(uuid.uuid4())
            used.add(identifier)
            function = call.get('function', {})
            arguments = function.get('arguments', '{}')
            normalized.append({'id': identifier, 'type': 'function',
                               'function': {'name': function.get('name', ''), 'arguments': arguments}})
            try:
                args = json.loads(arguments)
                if not isinstance(args, dict):
                    raise ValueError('Invalid tool arguments')
                actions.append({**args, 'action': function.get('name', '')})
            except (ValueError, TypeError):
                actions.append({'action': 'invalid_tool_arguments'})
        self.last_note = message.get('content') if isinstance(message.get('content'), str) else ''
        hidden = next((message.get(k) for k in ('reasoning_content', 'reasoning', 'thinking') if isinstance(message.get(k), str) and message.get(k).strip()), '')
        self.last_reasoning = hidden.strip()[:100000]
        assistant = {'role': 'assistant', 'content': message.get('content')}
        if normalized:
            assistant['tool_calls'] = normalized
        self.remember(assistant)
        self.pending_calls = normalized
        return actions
