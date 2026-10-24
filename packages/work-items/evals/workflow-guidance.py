#!/usr/bin/env python3
# SPDX-License-Identifier: LicenseRef-PolyForm-Shield-1.0.0
# SPDX-FileCopyrightText: 2026 Cogni-DAO
"""One narrow live internal-graph eval; read-only, normal billed chat, no retries/writes.

Cases are private JSON inputs: [{id,itemId,facts,expected:{decision,evidence?},stateKey?}].
Expected labels are never sent to the model. At most eight graph requests per run.
Exit 0=all pass, 1=behavior failure, 2=unscorable. No autonomous-shipping claim.
"""
import argparse
import hashlib
import json
from pathlib import Path
import time
import urllib.request as U
import urllib.error
from urllib.parse import urlsplit


def fingerprint(value):
    return hashlib.sha256(json.dumps(value, sort_keys=True, separators=(',', ':')).encode()).hexdigest()


def trajectory(sse):
    events = []
    for line in sse.splitlines():
        if line.startswith('data: ') and line[6:] != '[DONE]':
            try:
                events.append(json.loads(line[6:]))
            except json.JSONDecodeError:
                return None
    if any(e.get('type') in ('error', 'abort', 'tool-output-error') for e in events):
        return None
    if not any(e.get('type') == 'finish' for e in events):
        return None
    names = {e.get('toolCallId'): e.get('toolName') for e in events
             if e.get('type') in ('tool-input-start', 'tool-input-available')}
    inputs = {e.get('toolCallId'): e.get('input') for e in events if e.get('type') == 'tool-input-available'}
    reads = [(e.get('output'), inputs.get(e.get('toolCallId'))) for e in events
             if e.get('type') == 'tool-output-available'
             and names.get(e.get('toolCallId')) == 'core__work_item_query']
    # Score only final user-visible text, never reasoning or serialized tool IO.
    text = ''.join(e.get('delta', '') for e in events if e.get('type') == 'text-delta')
    try:
        final = json.loads(text.strip())
    except (json.JSONDecodeError, TypeError):
        final = None
    return reads, final


def grade(sse, item_id, expected):
    parsed = trajectory(sse)
    if parsed is None:
        return {'verdict': 'unscorable', 'reason': 'incomplete_or_error_trajectory'}
    reads, final = parsed
    if not reads:
        return {'verdict': 'fail', 'reason': 'no_observed_query'}
    if any(not isinstance(inp,dict) for _,inp in reads):
        return {'verdict':'unscorable','reason':'query_input_unavailable'}
    if not any(inp.get('ids') == [item_id] and inp.get('limit') == 1 for _,inp in reads):
        return {'verdict':'fail','reason':'wrong_query_scope'}
    packets = [i.get('nextCheckpoint') for read,inp in reads if isinstance(read, dict) and inp.get('ids') == [item_id]
               for i in read.get('items', []) if i.get('id') == item_id and i.get('nextCheckpoint')]
    if not packets:
        return {'verdict': 'unscorable', 'reason': 'checkpoint_packet_unavailable'}
    packet = packets[-1]
    if not isinstance(final, dict):
        return {'verdict': 'fail', 'reason': 'final_answer_not_json'}
    same = (final.get('itemId') == item_id
            and final.get('checkpointId') == packet.get('checkpointId')
            and final.get('definitionHash') == packet.get('definitionHash')
            and final.get('expectedRevision') == packet.get('expectedRevision'))
    matched = (same and final.get('decision') == expected['decision']
               and final.get('evidence') == expected.get('evidence', {}))
    return {'verdict': 'pass' if matched else 'fail', 'reason': 'exact_choice' if matched else 'wrong_choice_or_stale_packet',
            'checkpointId': packet.get('checkpointId'), 'definitionHash': packet.get('definitionHash'),
            'packetFingerprint': fingerprint(packet), 'answerFingerprint': fingerprint(final),
            'observedQueryCount': len(reads)}


def controls():
    packet = {'workflowId':'cicd-v1','checkpointId':'review_ci','definitionHash':'a'*64,'expectedRevision':2}
    answer = {'itemId':'task.1','checkpointId':'review_ci','definitionHash':'a'*64,'expectedRevision':2,
              'decision':'HOLD','evidence':{},'reason':'missing CI'}
    def stream(content, output=True, terminal=True):
        events = [{'type':'tool-input-start','toolCallId':'q','toolName':'core__work_item_query'}, {'type':'tool-input-available','toolCallId':'q','toolName':'core__work_item_query','input':{'ids':['task.1'],'limit':1}}]
        if output: events.append({'type':'tool-output-available','toolCallId':'q','output':{'items':[{'id':'task.1','nextCheckpoint':packet}]}})
        events.extend([{'type':'reasoning-delta','delta':json.dumps(answer)}, {'type':'text-delta','delta':content}])
        if terminal: events.append({'type':'finish'})
        return '\n'.join('data: '+json.dumps(e) for e in events)
    expected={'decision':'HOLD'}
    assert grade(stream(json.dumps(answer)), 'task.1', expected)['verdict']=='pass'
    assert grade(stream('unsupported prose'), 'task.1', expected)['verdict']=='fail'
    assert grade(stream(json.dumps(answer),output=False), 'task.1', expected)['verdict']=='fail'
    assert grade(stream(json.dumps(answer),terminal=False), 'task.1', expected)['verdict']=='unscorable'
    wrong={**answer,'decision':'COMPLETE'}
    assert grade(stream(json.dumps(wrong)), 'task.1', expected)['verdict']=='fail'
    return 5


class NoRedirect(U.HTTPRedirectHandler):
    def redirect_request(self, *args, **kwargs):
        return None


def main():
    parser=argparse.ArgumentParser(description=__doc__)
    parser.add_argument('--controls-only', action='store_true')
    for flag in ['base','env-file','cases','out','model']:
        parser.add_argument('--'+flag)
    args=parser.parse_args()
    count=controls()
    if args.controls_only:
        print(json.dumps({'controls':'pass','count':count}));return 0
    if not all([args.base,args.env_file,args.cases,args.out,args.model]):
        parser.error('base, env-file, cases, out and explicit model are required')
    origin=urlsplit(args.base)
    if origin.scheme!='https' or origin.username or origin.password or origin.query or origin.fragment or origin.path not in ('','/'):
        parser.error('base must be an HTTPS origin')
    saved={}
    for line in Path(args.env_file).read_text().splitlines():
        if '=' in line and not line.lstrip().startswith('#'):
            key,value=line.removeprefix('export ').split('=',1);saved[key.strip()]=value.strip().strip('\"\'')
    key=saved.get('COGNI_NODE_API_KEY')
    if not key: parser.error('explicit credential file has no node key; no inherited fallback')
    cases=json.loads(Path(args.cases).read_text())
    if not isinstance(cases,list) or not 1<=len(cases)<=8: parser.error('one to eight cases required')
    opener=U.build_opener(NoRedirect())
    def request(path, body=None):
        headers={'Authorization':'Bearer '+key,'User-Agent':'curl/8','Content-Type':'application/json'}
        req=U.Request(args.base.rstrip('/')+path,headers=headers,data=None if body is None else json.dumps(body).encode())
        with opener.open(req,timeout=120) as response:
            return response.read(2*1024*1024+1).decode(),dict(response.headers)
    version=json.loads(request('/version')[0])
    card={'criterion':'current-checkpoint guidance/action selection; read-only graph, external actuator separate',
          'graderSha256':hashlib.sha256(Path(__file__).read_bytes()).hexdigest(),'controlsPassed':count,
          'buildSha':version.get('buildSha'),'model':args.model,'graph':'workflow-guide','cases':[]}
    for case in cases:
        began=time.monotonic()
        message='Read the current workflow checkpoint for '+case['itemId']+'. Observed facts: '+json.dumps(case['facts'],sort_keys=True)+'. Propose the next action using your graph instructions.'
        if len(message)>3900: parser.error('case message exceeds 3900 chars')
        body={'message':message,'modelRef':{'providerKey':'platform','modelId':args.model},'graphName':'workflow-guide'}
        if case.get('stateKey'): body['stateKey']=case['stateKey']
        result={'id':case['id'],'inputFingerprint':fingerprint({'itemId':case['itemId'],'facts':case['facts']}),
                'expectedFingerprint':fingerprint(case['expected'])}
        try:
            sse,headers=request('/api/v1/ai/chat',body)
            if len(sse.encode())>2*1024*1024:
                result.update(verdict='unscorable',reason='stream_too_large')
            else:
                result.update(grade(sse,case['itemId'],case['expected']))
            result.update(runId=headers.get('x-run-id') or headers.get('X-Run-Id'),
                          stateKey=headers.get('x-state-key') or headers.get('X-State-Key'),
                          streamFingerprint=hashlib.sha256(sse.encode()).hexdigest())
        except (urllib.error.URLError,TimeoutError,ValueError) as error:
            result.update(verdict='unscorable',reason=type(error).__name__)
        result['latencySeconds']=round(time.monotonic()-began,2)
        card['cases'].append(result)
        Path(args.out).write_text(json.dumps(card,indent=2)+'\n')
        print(json.dumps(result),flush=True)
    after=json.loads(request('/version')[0]).get('buildSha')
    card['buildStable']=after==card['buildSha'];Path(args.out).write_text(json.dumps(card,indent=2)+'\n')
    if not card['buildStable'] or any(x['verdict']=='unscorable' for x in card['cases']):return 2
    return 0 if all(x['verdict']=='pass' for x in card['cases']) else 1


if __name__=='__main__':
    raise SystemExit(main())
