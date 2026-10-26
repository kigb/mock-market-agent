import io
import json
import sys
import unittest
from pathlib import Path
from unittest.mock import patch
sys.path.insert(0, str(Path(__file__).resolve().parents[1] / 'agents'))
from arena_agent import ModelAgent

class FakeMCP:
    def __init__(self):
        self.metrics = 0
        self.orders = []
    def tools(self):
        return [{'name': name, 'description': name, 'inputSchema': {'type': 'object', 'properties': {}, 'required': []}}
                for name in ['get_rules', 'get_order_book', 'get_position', 'place_order', 'wait']]
    def call_tool(self, name, arguments=None):
        if name == 'get_rules':
            return {'durationSeconds': 60, 'botBestProbability': .5, 'botWorstProbability': .5}
        if name == 'get_order_book':
            return {'result': {'status': 'finished' if self.metrics >= 2 else 'running', 'remainingMs': 60000,
                               'book': {'bestBid': 17, 'bestAsk': 18}, 'position': {'position': 0}, 'openOrders': []}}
        if name == 'get_position':
            return {'result': {'position': {'position': 0}, 'openOrders': []}}
        if name == 'place_order':
            self.orders.append(arguments)
            return {'result': {'orderId': 'new-order', 'filledQuantity': 1}}
        if name == 'record_decision':
            self.metrics += 1
            return {'result': {'recorded': True}}
        return {'result': {'status': 'waiting'}}

class AgentHistoryTests(unittest.TestCase):
    def make_agent(self, mcp=None):
        return ModelAgent(mcp=mcp or FakeMCP(), game_id='game_fixture', agent_token='PRIVATE_AGENT_TOKEN',
                          provider='sail', model='fixture', api_key='PRIVATE_PROVIDER_KEY')
    def test_read_result_is_followed_by_an_order_in_the_same_turn(self):
        mcp = FakeMCP()
        agent = self.make_agent(mcp)
        requests = []
        def provider(request, **kwargs):
            body = json.loads(request.data)
            requests.append(body)
            name, args = ('get_position', {}) if len(requests) == 1 else ('place_order', {'side': 'buy', 'type': 'limit', 'quantity': 1, 'price': 18})
            return io.BytesIO(json.dumps({'choices': [{'message': {'content': None, 'tool_calls': [
                {'id': 'call-'+str(len(requests)), 'type': 'function', 'function': {'name': name, 'arguments': json.dumps(args)}}]}}]}).encode())
        with patch('arena_agent.urlopen', provider), patch('arena_agent.time.sleep'):
            agent.run()
        self.assertEqual(len(mcp.orders), 1)
        self.assertEqual(len(requests), 2)
        self.assertEqual(requests[1]['messages'][-1]['role'], 'tool')
        self.assertEqual(requests[1]['messages'][-1]['tool_call_id'], 'call-1')
        self.assertEqual(json.loads(requests[1]['messages'][-1]['content'])['result']['position']['position'], 0)
        self.assertEqual([m['role'] for m in agent.history], ['user', 'assistant', 'tool', 'assistant', 'tool'])
        self.assertEqual(len(agent.trajectory), 5)
        self.assertNotIn('PRIVATE_PROVIDER_KEY', json.dumps(agent.trajectory))
        self.assertNotIn('PRIVATE_AGENT_TOKEN', json.dumps(agent.trajectory))
    def test_entire_history_survives_and_credentials_are_redacted(self):
        agent = self.make_agent()
        for i in range(180):
            agent.remember({'role': 'user', 'content': str(i)})
        agent.remember({'role': 'assistant', 'content': 'PRIVATE_PROVIDER_KEY PRIVATE_AGENT_TOKEN'})
        observed = agent.observe()
        received = []
        def provider(request, **kwargs):
            received.append(json.loads(request.data))
            return io.BytesIO(b'{"choices":[{"message":{"content":"Keeping the current quotes."}}]}')
        with patch('arena_agent.urlopen', provider):
            self.assertEqual(agent.decide(observed), [])
        self.assertEqual(received[0]['messages'][1]['content'], '0')
        self.assertEqual(len(received[0]['messages']), 183)
        self.assertNotIn('PRIVATE_PROVIDER_KEY', json.dumps(received[0]['messages']))
        self.assertNotIn('PRIVATE_AGENT_TOKEN', json.dumps(received[0]['messages']))

if __name__ == '__main__':
    unittest.main()
