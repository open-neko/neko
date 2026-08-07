#!/usr/bin/env python3
"""Build a self-contained digital-twin HTML from a world spec.

Usage: python3 build.py <world.json> <output.html>

Inlines the prebuilt Babylon.js bundle and the generic engine, injects the
world spec, and writes a single HTML file with no external dependencies
(safe for strict CSP environments like Claude Artifacts).
"""
import json, os, sys

def main():
    if len(sys.argv) != 3:
        sys.exit(__doc__)
    world_path, out_path = sys.argv[1], sys.argv[2]
    assets = os.path.join(os.path.dirname(os.path.abspath(__file__)), '..', 'assets')
    world = json.load(open(world_path))

    problems = validate(world)
    if problems:
        sys.exit('world spec problems:\n  - ' + '\n  - '.join(problems))

    default_note = ('<b>A pure projection.</b> No simulation, no floor plans — every '
                    'object on this screen is a live query over your data, laid out '
                    'procedurally from the schema. Click anything to see the query behind it.')
    # '</' inside strings would terminate the inline <script> block
    world_js = json.dumps(world).replace('</', '<\\/')

    html = open(os.path.join(assets, 'template.html')).read()
    html = html.replace('__TITLE__', world.get('title', 'Digital Twin'))
    html = html.replace('__EYEBROW__', world.get('eyebrow', 'Digital Twin'))
    html = html.replace('__NOTE__', world.get('note', default_note))
    html = html.replace('__WORLD__', world_js)
    html = html.replace('__ENGINE__', open(os.path.join(assets, 'engine.js')).read())
    html = html.replace('__BABYLON__', open(os.path.join(assets, 'babylon.js')).read())

    open(out_path, 'w').write(html)
    print(f'wrote {out_path} ({len(html)/1e6:.1f} MB)')

def validate(world):
    problems = []
    districts = world.get('districts') or []
    if not districts:
        problems.append('no districts defined')
    ids = set()
    for d in districts:
        if not d.get('id'): problems.append('district missing id')
        for b in d.get('buildings') or []:
            if not b.get('id'): problems.append(f'building in {d.get("id")} missing id')
            if b.get('id') in ids: problems.append(f'duplicate building id {b.get("id")}')
            ids.add(b.get('id'))
        if not d.get('buildings'): problems.append(f'district {d.get("id")} has no buildings')
    for f in world.get('findings') or []:
        if f.get('target') not in ids:
            problems.append(f'finding {f.get("id")} targets unknown building {f.get("target")}')
    for fl in world.get('flows') or []:
        dst = fl.get('to')
        if dst and not str(dst).startswith('offmap') and dst not in ids \
           and dst not in [d.get('id') for d in districts]:
            problems.append(f'flow targets unknown id {dst}')
    return problems

if __name__ == '__main__':
    main()
