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
import re
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
            if a.get('gameId') and a.get('agentToken'):
                return self._rest('games/'+a['gameId']+'/book', token=a['agentToken'])['result']['rules']
            return self._rest('rules'+('?botMode='+a['botMode'] if a.get('botMode') else ''))
        if name == 'create_game':
            body = {'seed': a.get('seed', 42), 'agents': [], 'botMode': a.get('botMode', 'market_relative')}
            if a.get('durationSeconds') is not None:
                body['durationSeconds'] = a['durationSeconds']
            return self._rest('games', 'POST', body)
        game = 'games/' + a.get('gameId', '')
        token = a.get('agentToken')
        if name == 'register_agent':
            return self._rest(game+'/agents', 'POST', {'name': a['name']}, a.get('hostToken'))
        if name == 'start_game':
            return self._rest(game+'/start', 'POST', {}, a.get('hostToken'))
        if name in ('get_order_book', 'get_position', 'get_atlas_history', 'get_fills'):
            data = self._rest(game+'/book', token=token)
            o = data['result']
            if name == 'get_position':
                data['result'] = {k: o[k] for k in ('position', 'openOrders', 'riskCapacity')}
            elif name == 'get_atlas_history':
                limit = int(a.get('limit') or 20)
                ticks = (o.get('atlas') or {}).get('ticks') or []
                data['result'] = {'total': len(ticks), 'ticks': ticks[-limit:]}
            elif name == 'get_fills':
                limit = int(a.get('limit') or 10)
                data['result'] = {'fills': [{'time': f.get('time'), 'side': f.get('side'), 'price': f.get('price'), 'quantity': f.get('quantity'), 'taker': f.get('taker'), 'maker': f.get('maker')} for f in (o.get('recentFills') or [])[:limit]]}
            return data
        if name == 'get_results':
            return self._rest(game+'/results', token=a.get('token'))
        if name == 'wait':
            return {'result': {'status': 'waiting'}}
        routes = {'place_order': 'orders', 'replace_order': 'replace', 'cancel_order': 'cancel', 'cancel_all': 'cancel', 'record_decision': 'metrics'}
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
                for turn in range(3):
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
                        if name in ('place_order', 'replace_order', 'cancel_order', 'cancel_all'):
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
                    if not actions or budget == 0 or any(a['action'] not in READ_TOOLS for a in actions):
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

READ_TOOLS = ('get_rules', 'get_order_book', 'get_position', 'get_atlas_history', 'get_fills')

def label_party(ident, me, others=None):
    """you / Atlas / a stable pseudonym (other-N) for another agent, assigned in order of first appearance."""
    if ident == '$atlas':
        return 'Atlas'
    if ident == me:
        return 'you'
    if isinstance(others, dict) and isinstance(ident, str) and ident not in ('other',) and '-' in ident:
        return others.setdefault(ident, f'other-{len(others) + 1}')
    return ident if isinstance(ident, str) and ident.startswith('other') else 'other'

def header_snapshot(o: dict, since_time: float) -> dict:
    """The per-turn header: the minimum every decision needs; details are pulled through the read tools."""
    ticks = [t for t in ((o.get('atlas') or {}).get('ticks') or []) if t.get('filledQuantity')]
    return {'serverTime': o.get('serverTime'), 'remainingMs': o.get('remainingMs'), 'lastPrice': o.get('lastPrice'),
            'bestBid': (o.get('book') or {}).get('bestBid'), 'bestAsk': (o.get('book') or {}).get('bestAsk'),
            'position': (o.get('position') or {}).get('position', 0), 'pnl': (o.get('position') or {}).get('pnl', 0),
            'openOrders': len(o.get('openOrders') or []),
            'atlasFillsSinceLastTurn': sum(1 for t in ticks if (t.get('time') or 0) > since_time), 'atlasFillsTotal': len(ticks)}

def read_summary(action: str, result) -> dict:
    """One-line stand-in replayed on later turns instead of a read result."""
    n = lambda v: len(v) if isinstance(v, list) else 0
    r = result if isinstance(result, dict) else {}
    if action == 'get_order_book':
        text = f"Viewed the order book ({n((r.get('book') or {}).get('bids')) + n((r.get('book') or {}).get('asks'))} levels), your {n(r.get('openOrders'))} open orders, position, recent fills and {n((r.get('atlas') or {}).get('ticks'))} Atlas executions"
    elif action == 'get_atlas_history':
        text = f"Viewed {n(r.get('ticks'))} Atlas executions"
    elif action == 'get_fills':
        text = f"Viewed {n(r.get('fills'))} recent fills"
    elif action == 'get_position':
        text = f"Viewed your position and {n(r.get('openOrders'))} open orders"
    else:
        text = 'Viewed the rules'
    return {'ephemeral': True, 'note': text + ' on that turn; call the tool again for current data.'}

def lean_position(p: dict) -> dict:
    return {k: p.get(k) for k in ('position', 'cash', 'pnl', 'realizedPnl', 'unrealizedPnl', 'averageEntry', 'fills', 'makerFills', 'takerFills', 'peakPosition', 'maxDrawdown')}

def lean_orders(orders: list, server_time) -> list:
    return [{'id': o.get('id'), 'side': o.get('side'), 'price': o.get('price'), 'quantity': o.get('quantity'),
             'filled': (o.get('originalQuantity') or 0) - (o.get('quantity') or 0) if isinstance(o.get('originalQuantity'), (int, float)) else 0,
             'ageMs': max(0, server_time - o['time']) if isinstance(server_time, (int, float)) and isinstance(o.get('time'), (int, float)) else None} for o in orders]

def lean_snapshot(value, others=None):
    """Model-facing view of an observation or a tool result: no static rules, the trading view of the account, compact
    orders and fills, counterparties labelled you / Atlas / other-N. The full data stays in the arena."""
    if isinstance(value, dict) and 'book' in value:
        me = (value.get('position') or {}).get('id')
        who = lambda ident: label_party(ident, me, others)
        lean = {k: v for k, v in value.items() if k not in ('rules', 'position', 'openOrders', 'recentFills', 'atlas')}
        pos = value.get('position')
        if isinstance(pos, dict):
            lean['position'] = lean_position(pos)
        if isinstance(value.get('openOrders'), list):
            lean['openOrders'] = lean_orders(value['openOrders'], value.get('serverTime'))
        if isinstance(value.get('recentFills'), list):
            lean['recentFills'] = [{'time': f.get('time'), 'side': f.get('side'), 'price': f.get('price'), 'quantity': f.get('quantity'),
                                    'taker': who(f.get('taker')), 'maker': who(f.get('maker'))} for f in value['recentFills']]
        atlas = value.get('atlas')
        if isinstance(atlas, dict):
            ticks = atlas.get('ticks')
            lean['atlas'] = {**atlas, 'ticks': [{**t, 'executions': [{**x, 'maker': who(x.get('maker'))} for x in t.get('executions', [])]} if isinstance(t, dict) else t for t in ticks]} if isinstance(ticks, list) else atlas
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
        if isinstance(result.get('ticks'), list):
            return {**value, 'result': {**result, 'ticks': [{**t, 'executions': [{**x, 'maker': label_party(x.get('maker'), None, others)} for x in t.get('executions', [])]} if isinstance(t, dict) else t for t in result['ticks']]}}
        if isinstance(result.get('fills'), list):
            return {**value, 'result': {**result, 'fills': [{**f, 'taker': label_party(f.get('taker'), None, others), 'maker': label_party(f.get('maker'), None, others)} for f in result['fills']]}}
        if isinstance(result.get('position'), dict) and 'id' in result['position']:
            return {**value, 'result': {'position': lean_position(result['position']), 'openOrders': lean_orders(result.get('openOrders') or [], None)}}
        return {**value, 'result': lean_snapshot(result, others)}
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

def safe_baseline_actions(o: dict, actions: list[dict]) -> list[dict]:
    if (o.get('rules') or {}).get('botMode') != 'market_relative':
        return actions
    position = o['position']['position']
    pending = {'buy': sum(x['quantity'] for x in o.get('openOrders', []) if x['side'] == 'buy'),
               'sell': sum(x['quantity'] for x in o.get('openOrders', []) if x['side'] == 'sell')}
    out = []
    for original in actions:
        a = dict(original)
        if a.get('action') == 'cancel_all':
            pending = {'buy': 0, 'sell': 0}
        if a.get('action') == 'place_order':
            side = a['side']
            capacity = (20-position if side == 'buy' else 20+position) - pending[side]
            a['quantity'] = min(a['quantity'], 20, capacity)
            if a['quantity'] <= 0:
                continue
            if a.get('type') == 'market':
                best = o['book']['bestAsk' if side == 'buy' else 'bestBid']
                if best is None:
                    continue
                a['price'] = best
            pending[side] += a['quantity']
        out.append(a)
    return out

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

# Apply only to these rule strategies; provider-backed agents receive explicit server errors unchanged.
for _baseline_class in (MarketMakerAgent, MeanReversionAgent, MomentumAgent):
    _original_decide = _baseline_class.decide
    def _bounded_decide(self, observation, _decide=_original_decide):
        return safe_baseline_actions(observation, _decide(self, observation))
    _baseline_class.decide = _bounded_decide

class ModelAgent(BaseAgent):
    """A provider-backed agent that executes its chosen tools through real MCP.

    API compatibility: OpenAI-style /chat/completions with function tools.
    The actual underlying model must support tool calling.
    """
    def __init__(self, *args, provider: str, model: str, api_key: str, base_url: str = '',
                 temperature: float = .3, max_tokens: int = 512, prompt: str = '', reasoning_effort: str = '', **kwargs):
        super().__init__(*args, **kwargs)
        # Sail and Fireworks accept OpenAI-style reasoning_effort (none/low/medium/high); it is recorded with every decision.
        self.reasoning_effort = reasoning_effort if provider in ('sail', 'fireworks') else ''
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
        # Ephemeral reads: index in history -> one-line reminder replayed on later turns instead of the data.
        self.replay_overrides: dict[int, dict] = {}
        self.turn_start = 0
        self.last_turn_time = 0
        # Other agents' ids -> other-N, assigned on first appearance and stable for the round.
        self.party_names: dict[str, str] = {}
        names = {*READ_TOOLS, 'place_order', 'replace_order', 'cancel_order', 'cancel_all', 'wait'}
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
            self.remember({'role': 'tool', 'tool_call_id': call['id'], 'content': json.dumps(lean_snapshot(result, self.party_names))})
            name = call['function']['name']
            if name in READ_TOOLS and result.get('ok'):
                self.replay_overrides[len(self.history) - 1] = {'role': 'tool', 'tool_call_id': call['id'], 'content': json.dumps(read_summary(name, result.get('result')))}
        self.pending_calls = []

    def decide(self, o: dict) -> list[dict]:
        return self.infer(o, fresh=True)

    def followup(self, o: dict) -> list[dict]:
        return self.infer(o, fresh=False)

    def infer(self, o: dict, fresh: bool) -> list[dict]:
        if fresh:
            # Only the compact header enters history; the model pulls details with the read tools.
            self.turn_start = len(self.history)
            self.remember({'role': 'user', 'content': json.dumps(header_snapshot(o, self.last_turn_time))})
            self.last_turn_time = o.get('serverTime') or self.last_turn_time
        headers = {'Content-Type': 'application/json', 'User-Agent': 'MarketArenaAgent/3.0'}
        if self.api_key:
            headers['Authorization'] = 'Bearer ' + self.api_key
        system = ('Compete in this timed trading arena; the rules give durationSeconds and every snapshot gives remainingMs. Maximize final total P&L: cash plus inventory valued according to this game’s selected settlement rule. '
                  'Market-relative mode has no hidden value and settles at trade VWAP; infer C only when hidden_center mode is explicitly selected. Obey reserved position capacity and use protected prices for taking. No opening price is supplied. '
                  'Your conversation from this round is retained; each turn you get only a short header (time left, last price, best bid/ask, position, P&L, open-order count, Atlas fills since your last turn) and pull details with get_order_book, get_atlas_history, get_fills or get_position. Read results are shown only within the current decision; later turns see a one-line reminder, so read again when you need current data. '
                  'Begin every reply with one or two plain sentences saying what you see and why you act (they are logged), then call the tools in the same reply. Use the provided tool contract and server action-rate bounds. All prices are dollars. Supply quotes when needed. Read the public Atlas mechanism: the exact arrival, price protection, quantity, and settlement rules for this game. Rules: '
                  + json.dumps(o.get('rules', self.rules)) + '\nStrategy: ' + self.prompt)
        replayed = [self.replay_overrides.get(i, m) if i < self.turn_start else m for i, m in enumerate(self.history)]
        payload = {'model': self.model, 'messages': [{'role': 'system', 'content': system}, *replayed],
                   'tools': self.model_tools, 'tool_choice': 'auto', 'temperature': self.temperature, 'stream': False}
        payload['max_completion_tokens' if self.provider == 'sail' else 'max_tokens'] = self.max_tokens
        if self.provider == 'fireworks':
            # Fireworks shortens an over-long prompt by default; ask for an error so history is never silently truncated.
            payload['context_length_exceeded_behavior'] = 'error'
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
        # Some providers return the chain of thought inline as <think>…</think>; split it off so it is recorded but
        # never replayed. The opening tag can be missing, and the block is unterminated when the budget ran out.
        inline_thinking = ''
        if isinstance(message.get('content'), str) and re.search(r'</?think>', message['content']):
            text = message['content']
            close, start = text.find('</think>'), text.find('<think>')
            if close >= 0 and (start < 0 or start > close):
                text = '<think>' + text
            thoughts = [t.strip() for t in re.findall(r'<think>(.*?)(?:</think>|$)', text, flags=re.S) if t.strip()]
            message = {**message, 'content': re.sub(r'<think>.*?(?:</think>|$)', '', text, flags=re.S).strip()}
            inline_thinking = '\n\n'.join(thoughts)
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
                # Never keep malformed arguments in the replayed history: providers reject every later request that carries them.
                normalized[-1]['function']['arguments'] = '{}'
                actions.append({'action': 'invalid_tool_arguments'})
        self.last_note = message.get('content') if isinstance(message.get('content'), str) else ''
        hidden = next((message.get(k) for k in ('reasoning_content', 'reasoning', 'thinking') if isinstance(message.get(k), str) and message.get(k).strip()), '') or inline_thinking
        self.last_reasoning = hidden.strip()[:100000]
        assistant = {'role': 'assistant', 'content': message.get('content')}
        if normalized:
            assistant['tool_calls'] = normalized
        self.remember(assistant)
        self.pending_calls = normalized
        return actions
