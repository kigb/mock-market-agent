import sys, unittest
from pathlib import Path
sys.path.insert(0,str(Path(__file__).resolve().parent.parent/'agents'))
from arena_agent import safe_baseline_actions, quote
class ModeTests(unittest.TestCase):
    def test_reserved_capacity_and_protection(self):
        o={'rules':{'botMode':'market_relative'},'position':{'position':18},'openOrders':[{'side':'buy','quantity':2}], 'book':{'bestAsk':50.02,'bestBid':50}}
        self.assertEqual(safe_baseline_actions(o,[quote('buy',50,1)]),[])
        actions=safe_baseline_actions(o,[{'action':'cancel_all'},{'action':'place_order','side':'buy','type':'market','quantity':5}])
        self.assertEqual(actions[1]['quantity'],2)
        self.assertEqual(actions[1]['price'],50.02)
    def test_legacy_actions_are_preserved(self):
        actions=[{'action':'place_order','side':'buy','type':'market','quantity':100}]
        self.assertEqual(safe_baseline_actions({'rules':{'botMode':'hidden_center'}},actions),actions)
if __name__=='__main__':unittest.main()
