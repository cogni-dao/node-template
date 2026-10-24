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
        if not line.startswith('data: ') or line[6:] == '[DONE]':
            continue
        try:
            event = json.loads(line[6:])
        except json.JSONDecodeError:
            return None
        if not isinstance(event, dict):
            return None
        events.append(event)
    finishes = [e for e in events if e.get('type') == 'finish']
    if (len(finishes) != 1 or finishes[0].get('finishReason') != 'stop'
            or not events or events[-1].get('type') != 'finish'
            or any(e.get('type') in ('error', 'abort', 'tool-output-error') for e in events)):
        return None
    calls = {}
    for event_index, event in enumerate(events):
        kind = event.get('type')
        if kind not in ('tool-input-start', 'tool-input-available', 'tool-output-available'):
            continue
        call_id = event.get('toolCallId')
        if not isinstance(call_id, str) or not call_id:
            return None
        call = calls.setdefault(call_id, {'inputs': [], 'outputs': []})
        if event.get('toolName'):
            if call.get('name') and call['name'] != event['toolName']:
                return None
            call['name'] = event['toolName']
        if kind == 'tool-input-available':
            call['inputs'].append(event.get('input'))
        elif kind == 'tool-output-available':
            call['outputs'].append(event.get('output'))
            call['outputIndex'] = event_index
    reads = []
    for call in sorted(calls.values(), key=lambda call: call.get('outputIndex', len(events))):
        # Announced but missing/failed IO is incomplete evidence, never a missing-tool failure.
        if (call.get('name') != 'core__work_item_query'
                or len(call['inputs']) != 1 or len(call['outputs']) != 1):
            return None
        inp, output = call['inputs'][0], call['outputs'][0]
        if isinstance(output, str):
            try:
                output = json.loads(output)
            except json.JSONDecodeError:
                return None
        if (not isinstance(inp, dict) or not isinstance(output, dict)
                or output.get('success') is False or 'error' in output
                or output.get('partial') is True or output.get('truncated') is True):
            return None
        meta = output.get('meta', {}).get('cogni', {}) if isinstance(output.get('meta'), dict) else {}
        if isinstance(meta, dict) and (meta.get('partial') is True or meta.get('truncated') is True or meta.get('attributionUnavailable', 0) != 0):
            return None
        reads.append((output, inp))
    text = ''.join(e.get('delta', '') for e in events if e.get('type') == 'text-delta')
    try:
        final = json.loads(text.strip())
    except (json.JSONDecodeError, TypeError):
        final = None
    return reads, final


def grade(sse, item_id, expected):
    parsed = trajectory(sse)
    if parsed is None:
        return {'verdict': 'unscorable', 'reason': 'incomplete_error_or_partial_trajectory'}
    reads, final = parsed
    if not reads:
        return {'verdict': 'fail', 'reason': 'no_observed_query'}
    if any(inp.get('ids') != [item_id] or inp.get('limit') != 1 for _, inp in reads):
        return {'verdict': 'fail', 'reason': 'wrong_query_scope'}
    # The most recent completed query is authoritative. Never fall back to an older packet.
    items = reads[-1][0].get('items')
    if not isinstance(items, list) or len(items) != 1 or not isinstance(items[0], dict) or items[0].get('id') != item_id:
        return {'verdict': 'unscorable', 'reason': 'current_item_unavailable'}
    packet = items[0].get('nextCheckpoint')
    if (not isinstance(packet, dict) or type(packet.get('expectedRevision')) is not int
            or packet['expectedRevision'] < 0 or 'checkpointId' not in packet
            or not isinstance(packet.get('workflowId'), str)):
        return {'verdict': 'unscorable', 'reason': 'current_checkpoint_unavailable'}
    if not isinstance(final, dict) or not isinstance(final.get('evidence'), dict):
        return {'verdict': 'fail', 'reason': 'final_answer_not_proposal'}
    revisions = [i.get('nextCheckpoint', {}).get('expectedRevision') for read, _ in reads for i in read.get('items', []) if isinstance(i, dict) and i.get('id') == item_id and isinstance(i.get('nextCheckpoint'), dict)]
    if any(type(revision) is int and revision > packet.get('expectedRevision', -1) for revision in revisions):
        return {'verdict': 'fail', 'reason': 'superseded_packet'}
    same = (final.get('itemId') == item_id
            and final.get('checkpointId') == packet.get('checkpointId')
            and final.get('definitionHash') == packet.get('definitionHash')
            and type(final.get('expectedRevision')) is int
            and final.get('expectedRevision') == packet.get('expectedRevision'))
    matched = (same and final.get('decision') == expected['decision']
               and final.get('evidence') == expected.get('evidence', {}))
    return {'verdict': 'pass' if matched else 'fail', 'reason': 'exact_choice' if matched else 'wrong_choice_or_stale_packet',
            'checkpointId': packet.get('checkpointId'), 'definitionHash': packet.get('definitionHash'),
            'packetFingerprint': fingerprint(packet), 'answerFingerprint': fingerprint(final),
            'observedQueryCount': len(reads), 'proposal': final}


def controls():
    packet = {'workflowId':'cicd-v1','checkpointId':'review_ci','definitionHash':'a'*64,'expectedRevision':2}
    answer = {'itemId':'task.1','checkpointId':'review_ci','definitionHash':'a'*64,'expectedRevision':2,
              'decision':'HOLD','evidence':{},'reason':'missing CI'}
    def query(call_id='q', output=True, value=None):
        events=[{'type':'tool-input-start','toolCallId':call_id,'toolName':'core__work_item_query'},
                {'type':'tool-input-available','toolCallId':call_id,'toolName':'core__work_item_query','input':{'ids':['task.1'],'limit':1}}]
        if output: events.append({'type':'tool-output-available','toolCallId':call_id,'output':value or {'items':[{'id':'task.1','nextCheckpoint':packet}]}})
        return events
    def stream(content, reads=None, finish='stop', terminal=True):
        events=query() if reads is None else reads
        events=events+[{'type':'reasoning-delta','delta':json.dumps(answer)}, {'type':'text-delta','delta':content}]
        if terminal: events.append({'type':'finish','finishReason':finish})
        return '\n'.join('data: '+json.dumps(e) for e in events)
    expected={'decision':'HOLD'}; count=0
    def check(sse, verdict):
        nonlocal count
        assert grade(sse,'task.1',expected)['verdict']==verdict
        count+=1
    check(stream(json.dumps(answer)), 'pass')
    check(stream('unsupported prose'), 'fail')
    check(stream(json.dumps(answer),reads=[]), 'fail')
    check(stream(json.dumps(answer),reads=query(output=False)), 'unscorable')
    check(stream(json.dumps(answer),terminal=False), 'unscorable')
    check(stream(json.dumps({**answer,'decision':'COMPLETE'})), 'fail')
    for reason in ['length','content-filter','error','tool-calls','other',None]:
        check(stream(json.dumps(answer),finish=reason), 'unscorable')
    check(stream(json.dumps(answer),reads=query()+query('late',output=False)), 'unscorable')
    check(stream(json.dumps(answer),reads=query()+query('late',value={'error':'unavailable'})), 'unscorable')
    check(stream(json.dumps(answer),reads=query(value={'items':[{'id':'task.1','nextCheckpoint':packet}],'partial':True})), 'unscorable')
    check(stream(json.dumps(answer),reads=query()+query('late',value={'items':[{'id':'task.1','nextCheckpoint':{**packet,'expectedRevision':3}}]})), 'fail')
    for malformed in [{'items':[None]}, {'items':[]}, {'items':[{'id':'task.1'}]}, {'items':[{'id':'task.1','nextCheckpoint':{}}]}]:
        check(stream(json.dumps(answer),reads=query(value=malformed)), 'unscorable')
    return count


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
        print(json.dumps({k:v for k,v in result.items() if k != "proposal"}),flush=True)
    try:
        after=json.loads(request('/version')[0]).get('buildSha')
        card['buildStable']=after==card['buildSha']
    except (urllib.error.URLError,TimeoutError,ValueError) as error:
        card['buildStable']=False;card['finalVersionError']=type(error).__name__
    card['counts']={verdict:sum(case['verdict']==verdict for case in card['cases']) for verdict in ['pass','fail','unscorable']}
    Path(args.out).write_text(json.dumps(card,indent=2)+'\n')
    if not card['buildStable'] or any(x['verdict']=='unscorable' for x in card['cases']):return 2
    return 0 if all(x['verdict']=='pass' for x in card['cases']) else 1


if __name__=='__main__':
    raise SystemExit(main())
