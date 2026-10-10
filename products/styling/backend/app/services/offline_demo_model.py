"""Small explicit-condition demo parser. No model HTTP and no paid-model claims."""
from contextlib import contextmanager
import re


class OfflineDemoParser:
    configured = True
    name = 'public-explicit-offline-demo'
    mode = 'offline_controlled_no_model_http'

    @contextmanager
    def call_accounting(self, callback):
        yield

    def parse(self, text, state, history, resources, dialog=None):
        from m2.core import validate_intent
        updates = {}
        if '通勤' in text:
            updates['scene'] = 'scene:work_commute'
        budget = re.search(r'预算\s*(\d+)\s*元?', text)
        if budget:
            updates['budget_max_fen'] = int(budget[1]) * 100
        sizes = {}
        for slot, label in [('top', '上衣'), ('bottom', '裤子')]:
            value = re.search(label + r'\s*(XL|S|M|L)', text)
            if value:
                sizes[slot] = {'system': 'clothing_alpha', 'value': value[1]}
        shoes = re.search(r'鞋\s*(3[5-9]|40)', text)
        if shoes:
            sizes['shoes'] = {'system': 'cn_shoe', 'value': shoes[1]}
        if sizes:
            updates['usual_sizes'] = sizes
        operation = 'modify_current' if '换搭' in text else 'initial_recommendation'
        intent = {'operation': operation, 'updates': updates}
        if operation == 'modify_current':
            intent['replace_slots'] = ['top', 'bottom', 'shoes']
        return validate_intent(intent, resources), {'mode': self.mode, 'model': self.name,
            'cost': 0, 'input_tokens': 0, 'output_tokens': 0}
