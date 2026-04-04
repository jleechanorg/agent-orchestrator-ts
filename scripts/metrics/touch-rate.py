#!/usr/bin/env python3
"""First-touch / second-touch rate calculator for merged PRs."""
import argparse, datetime, json, subprocess
from collections import Counter

GH_TIMEOUT_SECONDS = 60

def gh(path, paginate=False):
    cmd=['gh','api','--method','GET']
    if paginate:
        cmd += ['--paginate','--slurp']
    cmd.append(path)
    try:
        result = subprocess.run(cmd, text=True, capture_output=True, timeout=GH_TIMEOUT_SECONDS)
    except subprocess.TimeoutExpired:
        raise SystemExit(f'gh api timed out after {GH_TIMEOUT_SECONDS}s: {" ".join(cmd)}') from None
    if result.returncode != 0:
        stderr = (result.stderr or '').strip()
        raise SystemExit(f'gh api failed ({result.returncode}): {" ".join(cmd)}'
                         + (f'\nstderr: {stderr}' if stderr else '')) from None
    return result.stdout

def parse_gh_list(raw):
    """Parse --paginate --slurp output (array of arrays) into a flat list."""
    data = json.loads(raw)
    items = []
    for page in (data if isinstance(data, list) else [data]):
        parsed = page
        if isinstance(parsed, list):
            items.extend(parsed)
        else:
            items.append(parsed)
    return items

p=argparse.ArgumentParser(description='Calculate first-touch/second-touch rates for merged PRs.')
p.add_argument('--repo', required=True)
p.add_argument('--hours', type=int, default=24)
args=p.parse_args()
if args.hours <= 0:
    p.error('--hours must be a positive integer')

cutoff=datetime.datetime.now(datetime.timezone.utc)-datetime.timedelta(hours=args.hours)
prs=parse_gh_list(gh(f'repos/{args.repo}/pulls?state=closed&per_page=100', paginate=True))

recent=[]
for pr in prs:
    if not isinstance(pr, dict):
        continue
    m=pr.get('merged_at')
    if not m:
        continue
    mt=datetime.datetime.fromisoformat(m.replace('Z','+00:00'))
    if mt>=cutoff:
        recent.append(pr)

# CodeRabbit bot login — consistent with skeptic-gate.yml and skeptic-cron.yml
CR_BOT='coderabbitai[bot]'
touches=[]
for pr in recent:
    n=pr['number']
    reviews=parse_gh_list(gh(f'repos/{args.repo}/pulls/{n}/reviews?per_page=100', paginate=True))
    t=sum(1 for r in reviews if isinstance(r, dict) and
          (r.get('user') or {}).get('login','').lower()==CR_BOT and
          (r.get('state') or '').upper()=='CHANGES_REQUESTED')
    touches.append((n,t,pr['title']))

N=len(touches)
one=sum(1 for _,t,_ in touches if t==1)
two=sum(1 for _,t,_ in touches if t==2)
le1=sum(1 for _,t,_ in touches if t<=1)
print(json.dumps({
  'repo':args.repo,
  'hours':args.hours,
  'total_merged':N,
  'first_touch_rate_exact_1': None if N==0 else round(one/N,4),
  'second_touch_rate_exact_2': None if N==0 else round(two/N,4),
  'first_touch_rate_at_most_1': None if N==0 else round(le1/N,4),
  'distribution': dict(sorted(Counter(t for _,t,_ in touches).items())),
  'prs':[{'number':n,'touches':t,'title':title} for n,t,title in sorted(touches,key=lambda x:x[0], reverse=True)]
}, indent=2))
