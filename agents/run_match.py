#!/usr/bin/env python3
"""Run a complete timed match (180 seconds by default) with agents that trade through MCP.

    python run_match.py --agents maker momentum
    python run_match.py --agents maker llm --provider sail --model MODEL_ID

For a hosted public arena, set ARENA_URL to the website origin. Defaults to
http://127.0.0.1:5173. Provider credentials are read from environment variables.
"""
import argparse
import json
import os
import time
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path
from arena_agent import ArenaMCP, MarketMakerAgent, MomentumAgent, MeanReversionAgent, ModelAgent

def main():
    p = argparse.ArgumentParser(description=__doc__)
    p.add_argument('--agents', nargs='+', choices=['maker', 'momentum', 'mean-reversion', 'llm'], default=['maker', 'momentum'])
    p.add_argument('--url', default=os.getenv('ARENA_URL', 'http://127.0.0.1:5173'))
    p.add_argument('--transport', choices=['auto', 'mcp', 'rest'], default=os.getenv('ARENA_TRANSPORT', 'auto'))
    p.add_argument('--seed', type=int, default=42)
    p.add_argument('--duration', type=int, default=int(os.getenv('ARENA_DURATION_SECONDS', '180')),
                   help='Round length in seconds, 30–600 (default 180).')
    p.add_argument('--interval', type=float, default=0,
                   help='Seconds between decision starts per agent; 0 (default) means as soon as the previous decision lands.')
    p.add_argument('--provider', choices=['modal', 'sail', 'fireworks'], default='sail')
    p.add_argument('--model', default=os.getenv('ARENA_MODEL', ''))
    p.add_argument('--base-url', default=os.getenv('MODAL_BASE_URL', ''))
    p.add_argument('--reasoning-effort', choices=['none', 'low', 'medium', 'high'], default=os.getenv('ARENA_REASONING_EFFORT', ''),
                   help='Sail reasoning_effort for LLM agents; recorded with every decision for latency/quality comparisons.')
    p.add_argument('--output', default='arena-results.json')
    args = p.parse_args()
    if len(args.agents) > 8:
        p.error('Use at most eight agents.')
    key_name = {'sail': 'SAIL_API_KEY', 'fireworks': 'FIREWORKS_API_KEY', 'modal': 'MODAL_ENDPOINT_API_KEY'}[args.provider]
    if 'llm' in args.agents and (not args.model or (args.provider != 'modal' and not os.getenv(key_name))):
        p.error(f'LLM agents need --model and the {key_name} environment variable.')
    if 'llm' in args.agents and args.provider == 'modal' and not args.base_url:
        p.error('Modal agents need --base-url (a deployed OpenAI-compatible endpoint including /v1).')
    mcp = ArenaMCP(args.url, os.getenv('ARENA_SERVICE_TOKEN'), os.getenv('ARENA_MCP_TOKEN'), args.transport)
    print('Agent transport: ' + mcp.transport.upper())
    created = mcp.call_tool('create_game', {'seed': args.seed, 'durationSeconds': args.duration})
    game_id, host = created['state']['id'], created['hostToken']
    agents = []
    types = {'maker': MarketMakerAgent, 'momentum': MomentumAgent, 'mean-reversion': MeanReversionAgent}
    for i, strategy in enumerate(args.agents):
        registered = mcp.call_tool('register_agent', {'gameId': game_id, 'hostToken': host, 'name': f'{strategy.title()} {i+1}'})['result']
        kwargs = {'mcp': mcp, 'game_id': game_id, 'agent_token': registered['agentToken'], 'interval': args.interval}
        agent = ModelAgent(**kwargs, provider=args.provider, model=args.model, api_key=os.getenv(key_name, ''),
                           base_url=args.base_url, reasoning_effort=args.reasoning_effort) if strategy == 'llm' else types[strategy](**kwargs)
        agent.name, agent.agent_id = registered['name'], registered['agentId']
        agents.append(agent)
    started = mcp.call_tool('start_game', {'gameId': game_id, 'hostToken': host})
    print(f'Arena: {args.url}\nGame: {game_id}\n{len(agents)} agents. Trading closes in {created["state"]["durationMs"]//1000} seconds.')
    with ThreadPoolExecutor(max_workers=len(agents)) as executor:
        futures = [executor.submit(a.run) for a in agents]
        for future in futures:
            future.result()
    results = mcp.call_tool('get_results', {'gameId': game_id, 'token': host})
    while results['state']['status'] != 'finished':
        time.sleep(.5)
        results = mcp.call_tool('get_results', {'gameId': game_id, 'token': host})
    # The game's own rules (durationSeconds, schema) rather than the arena-wide defaults.
    report = {'rules': results['state'].get('rules') or mcp.call_tool('get_rules'), 'results': results['state'],
              'trajectories': [{'agentId': a.agent_id, 'name': a.name, 'messages': getattr(a, 'trajectory', [])} for a in agents]}
    try:
        # Server-side decision metrics for this host's agents (self-reported stamps plus server bookkeeping).
        report['decisions'] = mcp._rest(f'games/{game_id}/decisions', token=host)['decisions']
    except MCPError:
        report['decisions'] = []
    output_path = Path(args.output)
    output_path.parent.mkdir(parents=True, exist_ok=True)
    output_path.write_text(json.dumps(report, indent=2))
    print('\nFINAL LEADERBOARD')
    for a in results['state']['leaderboard']:
        print(f"{a['rank']}. {a['name']:<22} P&L {a['pnl']:+.2f}  filled {a['filledQuantity']}  position {a['position']:+}")
    print(f'Results saved to {args.output}; no credentials are included.')
    try:
        # Human-readable round log: what every agent saw, said, and did, with Atlas executions in between.
        log_path = output_path.with_suffix('.md')
        log_path.write_text(mcp._rest_text(f'games/{game_id}/log', token=host))
        print(f'Round log saved to {log_path}')
    except MCPError as exc:
        print(f'Round log unavailable: {exc}')

if __name__ == '__main__':
    main()
