"""Hand-built Notion workspace for the replay server, in documented API shapes (Notion-Version 2026-03-11).

Ids are dashed UUIDs ``1a2b3c4d-0000-4000-8000-00000000XXXX``:

* ``a0xx`` pages (Product Roadmap, Engineering Wiki, Meeting Notes)
* ``d0xx`` databases, ``d5xx`` data sources, ``c0xx`` / ``c1xx`` rows (pages in data sources)
* ``e0xx`` users, ``b0xx`` blocks, ``f0xx`` comments
"""

from __future__ import annotations

import copy


def nid(suffix: str) -> str:
    return f"1a2b3c4d-0000-4000-8000-{suffix.rjust(12, '0')}"


ADA, GRACE, LINUS, BOT = nid("e001"), nid("e002"), nid("e003"), nid("e0b1")
ROADMAP, WIKI, MEETING = nid("a001"), nid("a002"), nid("a003")
TASKS_DB, PROJECTS_DB, MULTI_DB = nid("d001"), nid("d002"), nid("d003")
TASKS_DS, PROJECTS_DS, BUGS_DS, REQUESTS_DS = nid("d501"), nid("d502"), nid("d503"), nid("d504")

USERS = [
    {"object": "user", "id": ADA, "type": "person", "name": "Ada Lovelace",
     "avatar_url": "https://example.com/ada.png", "person": {"email": "ada@example.com"}},
    {"object": "user", "id": GRACE, "type": "person", "name": "Grace Hopper", "avatar_url": None,
     "person": {"email": "grace@example.com"}},
    # No email: emulates an integration without the user-email capability for this user.
    {"object": "user", "id": LINUS, "type": "person", "name": "Linus Torvalds", "avatar_url": None, "person": {}},
    {"object": "user", "id": BOT, "type": "bot", "name": "VGI Notion", "avatar_url": None,
     "bot": {"owner": {"type": "workspace", "workspace": True}, "workspace_name": "Acme"}},
]
USER_BY_ID = {u["id"]: u for u in USERS}


def uref(uid: str) -> dict:
    return {"object": "user", "id": uid}


def text(s: str, *, bold: bool = False, italic: bool = False, code: bool = False, href: str | None = None) -> dict:
    return {
        "type": "text",
        "text": {"content": s, "link": {"url": href} if href else None},
        "annotations": {"bold": bold, "italic": italic, "strikethrough": False, "underline": False,
                        "code": code, "color": "default"},
        "plain_text": s,
        "href": href,
    }


def mention_user(uid: str) -> dict:
    name = USER_BY_ID[uid]["name"]
    return {"type": "mention", "mention": {"type": "user", "user": uref(uid)},
            "annotations": text("")["annotations"], "plain_text": f"@{name}", "href": None}


# ---------------------------------------------------------------- data source schemas

STATUS_OPTIONS = [
    {"id": "s-todo", "name": "Not started", "color": "default"},
    {"id": "s-prog", "name": "In progress", "color": "blue"},
    {"id": "s-done", "name": "Done", "color": "green"},
]

TASKS_PROPS = {
    "Name": {"id": "title", "name": "Name", "type": "title", "title": {}},
    "Status": {"id": "st%3Aa", "name": "Status", "type": "status", "status": {
        "options": STATUS_OPTIONS,
        "groups": [
            {"id": "g1", "name": "To-do", "color": "gray", "option_ids": ["s-todo"]},
            {"id": "g2", "name": "In progress", "color": "blue", "option_ids": ["s-prog"]},
            {"id": "g3", "name": "Complete", "color": "green", "option_ids": ["s-done"]},
        ]}},
    "Priority": {"id": "pri1", "name": "Priority", "type": "select", "select": {"options": [
        {"id": "p-h", "name": "High", "color": "red"},
        {"id": "p-m", "name": "Medium", "color": "yellow"},
        {"id": "p-l", "name": "Low", "color": "gray"}]}},
    "Tags": {"id": "tag1", "name": "Tags", "type": "multi_select", "multi_select": {"options": [
        {"id": "t-s", "name": "search", "color": "blue"},
        {"id": "t-b", "name": "backend", "color": "purple"},
        {"id": "t-f", "name": "frontend", "color": "pink"},
        {"id": "t-d", "name": "docs", "color": "brown"}]}},
    "Assignee": {"id": "ppl1", "name": "Assignee", "type": "people", "people": {}},
    "Due": {"id": "due1", "name": "Due", "type": "date", "date": {}},
    "Estimate": {"id": "est1", "name": "Estimate", "type": "number", "number": {"format": "number"}},
    "Blocked": {"id": "chk1", "name": "Blocked", "type": "checkbox", "checkbox": {}},
    "Project": {"id": "rel1", "name": "Project", "type": "relation", "relation": {
        "data_source_id": PROJECTS_DS, "database_id": PROJECTS_DB, "type": "single_property", "single_property": {}}},
    "Notes": {"id": "txt1", "name": "Notes", "type": "rich_text", "rich_text": {}},
    # Collides with the fixed `url` column (DuckDB compares identifiers case-insensitively).
    "URL": {"id": "url1", "name": "URL", "type": "url", "url": {}},
    "Owner email": {"id": "eml1", "name": "Owner email", "type": "email", "email": {}},
    "Attachments": {"id": "fil1", "name": "Attachments", "type": "files", "files": {}},
    "Task ID": {"id": "uid1", "name": "Task ID", "type": "unique_id", "unique_id": {"prefix": "TASK"}},
    "Created": {"id": "ctm1", "name": "Created", "type": "created_time", "created_time": {}},
    "Edited by": {"id": "leb1", "name": "Edited by", "type": "last_edited_by", "last_edited_by": {}},
    "Score": {"id": "fml1", "name": "Score", "type": "formula", "formula": {"expression": "prop(\"Estimate\") * 2"}},
    "Label": {"id": "fml2", "name": "Label", "type": "formula",
              "formula": {"expression": "prop(\"Name\") + \" (\" + prop(\"Status\") + \")\""}},
    "Project count": {"id": "rol1", "name": "Project count", "type": "rollup", "rollup": {
        "relation_property_name": "Project", "relation_property_id": "rel1",
        "rollup_property_name": "Name", "rollup_property_id": "title", "function": "count"}},
    "Project names": {"id": "rol2", "name": "Project names", "type": "rollup", "rollup": {
        "relation_property_name": "Project", "relation_property_id": "rel1",
        "rollup_property_name": "Name", "rollup_property_id": "title", "function": "show_original"}},
    "Run": {"id": "btn1", "name": "Run", "type": "button", "button": {}},
}

PROJECTS_PROPS = {
    "Name": {"id": "title", "name": "Name", "type": "title", "title": {}},
    "Lead": {"id": "lead", "name": "Lead", "type": "people", "people": {}},
}

SIMPLE_PROPS = {"Name": {"id": "title", "name": "Name", "type": "title", "title": {}}}


def data_source(ds_id, db_id, title, props, edited, parent_page=ROADMAP):
    return {
        "object": "data_source", "id": ds_id,
        "created_time": "2026-09-01T08:00:00.000Z", "last_edited_time": edited,
        "created_by": uref(ADA), "last_edited_by": uref(ADA),
        "title": [text(title)], "description": [text(f"{title} tracked by the team")],
        "icon": {"type": "emoji", "emoji": "✅"}, "cover": None,
        "properties": copy.deepcopy(props),
        "parent": {"type": "database_id", "database_id": db_id},
        "database_parent": {"type": "page_id", "page_id": parent_page},
        "is_inline": False, "in_trash": False, "url": f"https://www.notion.so/{ds_id.replace('-', '')}",
        "public_url": None,
    }


DATA_SOURCES = [
    data_source(TASKS_DS, TASKS_DB, "Tasks", TASKS_PROPS, "2026-11-10T12:00:00.000Z"),
    data_source(PROJECTS_DS, PROJECTS_DB, "Projects", PROJECTS_PROPS, "2026-11-01T12:00:00.000Z"),
    data_source(BUGS_DS, MULTI_DB, "Bugs", SIMPLE_PROPS, "2026-10-01T12:00:00.000Z", WIKI),
    data_source(REQUESTS_DS, MULTI_DB, "Requests", SIMPLE_PROPS, "2026-10-02T12:00:00.000Z", WIKI),
]
DS_BY_ID = {d["id"]: d for d in DATA_SOURCES}


def database(db_id, title, sources, parent_page=ROADMAP, inline=False):
    return {
        "object": "database", "id": db_id, "title": [text(title)], "description": [],
        "parent": {"type": "page_id", "page_id": parent_page}, "is_inline": inline, "is_locked": False,
        "in_trash": False, "created_time": "2026-09-01T08:00:00.000Z",
        "last_edited_time": "2026-11-10T12:00:00.000Z", "icon": None, "cover": None,
        "url": f"https://www.notion.so/{db_id.replace('-', '')}", "public_url": None,
        "data_sources": [{"id": s, "name": DS_BY_ID[s]["title"][0]["plain_text"]} for s in sources],
    }


DATABASES = [
    database(TASKS_DB, "Tasks", [TASKS_DS], inline=True),
    database(PROJECTS_DB, "Projects", [PROJECTS_DS]),
    database(MULTI_DB, "Feedback", [BUGS_DS, REQUESTS_DS], WIKI),
]
DB_BY_ID = {d["id"]: d for d in DATABASES}

# ---------------------------------------------------------------------------- rows

C101, C102 = nid("c101"), nid("c102")


def date(start, end=None, tz=None):
    return {"start": start, "end": end, "time_zone": tz}


TASKS = [
    # name, status, priority, tags, assignee, due, estimate, blocked, project, notes, created, edited
    dict(id=nid("c001"), name="Search revamp", status="In progress", priority="High", tags=["search", "backend"],
         people=[ADA], due=date("2026-11-20"), est=5, blocked=False, project=[C101],
         notes=[text("Ship "), text("search", bold=True), text(" by "), text("Q4", href="https://example.com/q4")],
         url="https://example.com/spec/1", email="ada@example.com", files=[
             {"name": "spec.pdf", "type": "file", "file": {"url": "https://files.example.com/spec.pdf",
                                                          "expiry_time": "2026-11-15T13:00:00.000Z"}}],
         uid=1, created="2026-10-01T09:00:00.000Z", edited="2026-11-10T12:00:00.000Z", editor=ADA),
    dict(id=nid("c002"), name="Index documents", status="Done", priority="Medium", tags=["search", "backend"],
         people=[ADA, GRACE], due=date("2026-10-15T10:00:00.000+00:00", "2026-10-20T18:00:00.000+00:00", "Europe/London"),
         est=3, blocked=False, project=[C101], notes=[], url=None, email=None, files=[], uid=2,
         created="2026-10-02T09:00:00.000Z", edited="2026-10-21T08:00:00.000Z", editor=GRACE),
    dict(id=nid("c003"), name="Crash on empty query", status="Not started", priority="High", tags=["backend"],
         people=[GRACE], due=None, est=2, blocked=True, project=[], notes=[text("Repro: search for nothing")],
         url=None, email="grace@example.com", files=[], uid=3,
         created="2026-10-03T09:00:00.000Z", edited="2026-10-03T09:00:00.000Z", editor=GRACE),
    dict(id=nid("c004"), name="Search UI", status="In progress", priority="Low", tags=["frontend", "search"],
         people=[], due=date("2026-12-01"), est=8, blocked=False,
         # Truncated in the page object (has_more); the property item endpoint has both.
         project=[C101, C102], project_truncated=True, notes=[], url=None, email=None, files=[
             {"name": "mock.png", "type": "external", "external": {"url": "https://example.com/mock.png"}}],
         uid=4, created="2026-10-04T09:00:00.000Z", edited="2026-11-05T15:30:00.000Z", editor=ADA),
    dict(id=nid("c005"), name="Write docs", status="Not started", priority=None, tags=["docs"],
         people=[LINUS], due=date("2026-11-05"), est=None, blocked=False, project=[C102], notes=[],
         url=None, email=None, files=[], uid=5,
         created="2026-10-05T09:00:00.000Z", edited="2026-10-05T09:00:00.000Z", editor=LINUS),
    dict(id=nid("c006"), name="Release 1.0", status="Done", priority="High", tags=[], people=[ADA],
         due=date("2026-11-03T16:00:00.000+00:00"), est=1, blocked=False, project=[C101, C102], notes=[],
         url=None, email=None, files=[], uid=6,
         created="2026-10-06T09:00:00.000Z", edited="2026-11-03T17:00:00.000Z", editor=ADA),
]

PROJECTS = [
    dict(id=C101, name="Search", lead=[ADA], created="2026-09-02T09:00:00.000Z"),
    dict(id=C102, name="Docs", lead=[LINUS], created="2026-09-03T09:00:00.000Z"),
]


def page_shell(pid, parent, title_prop, title, created, edited, editor=ADA, icon=None, props=None):
    p = {
        "object": "page", "id": pid, "created_time": created, "last_edited_time": edited,
        "created_by": uref(ADA), "last_edited_by": uref(editor), "cover": None, "icon": icon,
        "parent": parent, "in_trash": False, "is_locked": False,
        "properties": props if props is not None else {
            title_prop: {"id": "title", "type": "title", "title": [text(title)]}},
        "url": f"https://www.notion.so/{title.replace(' ', '-')}-{pid.replace('-', '')}", "public_url": None,
    }
    return p


def task_page(t: dict) -> dict:
    status = next((o for o in STATUS_OPTIONS if o["name"] == t["status"]), None)
    pri = next((o for o in TASKS_PROPS["Priority"]["select"]["options"] if o["name"] == t["priority"]), None)
    tagopts = {o["name"]: o for o in TASKS_PROPS["Tags"]["multi_select"]["options"]}
    est = t["est"]
    shown_projects = t["project"][:1] if t.get("project_truncated") else t["project"]
    names = {p["id"]: p["name"] for p in PROJECTS}
    label = f"{t['name']} ({t['status']})"
    props = {
        "Name": {"id": "title", "type": "title", "title": [text(t["name"])]},
        "Status": {"id": "st%3Aa", "type": "status", "status": status},
        "Priority": {"id": "pri1", "type": "select", "select": pri},
        "Tags": {"id": "tag1", "type": "multi_select", "multi_select": [tagopts[x] for x in t["tags"]]},
        "Assignee": {"id": "ppl1", "type": "people", "people": [
            {"object": "user", "id": u, "name": USER_BY_ID[u]["name"], "type": "person"} for u in t["people"]]},
        "Due": {"id": "due1", "type": "date", "date": t["due"]},
        "Estimate": {"id": "est1", "type": "number", "number": est},
        "Blocked": {"id": "chk1", "type": "checkbox", "checkbox": t["blocked"]},
        "Project": {"id": "rel1", "type": "relation", "relation": [{"id": x} for x in shown_projects],
                    "has_more": bool(t.get("project_truncated"))},
        "Notes": {"id": "txt1", "type": "rich_text", "rich_text": t["notes"]},
        "URL": {"id": "url1", "type": "url", "url": t["url"]},
        "Owner email": {"id": "eml1", "type": "email", "email": t["email"]},
        "Attachments": {"id": "fil1", "type": "files", "files": t["files"]},
        "Task ID": {"id": "uid1", "type": "unique_id", "unique_id": {"prefix": "TASK", "number": t["uid"]}},
        "Created": {"id": "ctm1", "type": "created_time", "created_time": t["created"]},
        "Edited by": {"id": "leb1", "type": "last_edited_by", "last_edited_by": {
            "object": "user", "id": t["editor"], "name": USER_BY_ID[t["editor"]]["name"]}},
        "Score": {"id": "fml1", "type": "formula", "formula": {"type": "number", "number": None if est is None else est * 2}},
        "Label": {"id": "fml2", "type": "formula", "formula": {"type": "string", "string": label}},
        "Project count": {"id": "rol1", "type": "rollup", "rollup": {
            "type": "number", "number": len(t["project"]), "function": "count"}},
        "Project names": {"id": "rol2", "type": "rollup", "rollup": {"type": "array", "function": "show_original", "array": [
            {"type": "title", "title": [text(names[x])]} for x in t["project"]]}},
        "Run": {"id": "btn1", "type": "button", "button": {}},
    }
    p = page_shell(t["id"], {"type": "data_source_id", "data_source_id": TASKS_DS, "database_id": TASKS_DB},
                   "Name", t["name"], t["created"], t["edited"], t["editor"], props=props)
    return p


def project_page(p: dict) -> dict:
    props = {
        "Name": {"id": "title", "type": "title", "title": [text(p["name"])]},
        "Lead": {"id": "lead", "type": "people", "people": [uref(u) for u in p["lead"]]},
    }
    return page_shell(p["id"], {"type": "data_source_id", "data_source_id": PROJECTS_DS, "database_id": PROJECTS_DB},
                      "Name", p["name"], p["created"], p["created"], props=props)


ROWS = {
    TASKS_DS: [task_page(t) for t in TASKS],
    PROJECTS_DS: [project_page(p) for p in PROJECTS],
    BUGS_DS: [],
    REQUESTS_DS: [],
}

# Full relation lists for truncated properties: (page_id, property_id) -> items.
PROPERTY_ITEMS = {
    (t["id"], "rel1"): [{"object": "property_item", "id": "rel1", "type": "relation", "relation": {"id": x}}
                        for x in t["project"]]
    for t in TASKS
}

PAGES = [
    page_shell(ROADMAP, {"type": "workspace", "workspace": True}, "title", "Product Roadmap",
               "2026-09-01T08:00:00.000Z", "2026-11-12T09:30:00.000Z", icon={"type": "emoji", "emoji": "🗺️"}),
    page_shell(WIKI, {"type": "page_id", "page_id": ROADMAP}, "title", "Engineering Wiki",
               "2026-09-05T08:00:00.000Z", "2026-11-01T10:00:00.000Z", GRACE),
    page_shell(MEETING, {"type": "workspace", "workspace": True}, "title", "Meeting Notes",
               "2026-09-10T08:00:00.000Z", "2026-10-20T10:00:00.000Z"),
    *ROWS[TASKS_DS],
    *ROWS[PROJECTS_DS],
]
PAGE_BY_ID = {p["id"]: p for p in PAGES}

# --------------------------------------------------------------------------- blocks

_seq = [0]


def blk(btype: str, body: dict, children: list | None = None) -> dict:
    _seq[0] += 1
    b = {
        "object": "block", "id": nid(f"b{_seq[0]:03x}"), "type": btype,
        "created_time": "2026-09-01T08:00:00.000Z", "last_edited_time": "2026-11-12T09:30:00.000Z",
        "created_by": uref(ADA), "last_edited_by": uref(ADA), "has_children": bool(children),
        "in_trash": False, btype: body, "_children": children or [],
    }
    return b


def rt(*items):
    return {"rich_text": list(items), "color": "default"}


def para(*items, children=None):
    return blk("paragraph", rt(*items), children)


ROADMAP_BLOCKS = [
    blk("heading_1", {**rt(text("Goals")), "is_toggleable": False}),
    para(text("Ship "), text("search", bold=True), text(" by "), text("Q4", href="https://example.com/q4"), text(".")),
    blk("bulleted_list_item", rt(text("Faster indexing")), [
        blk("bulleted_list_item", rt(text("Sharding"))),
        blk("bulleted_list_item", rt(text("Caching"))),
    ]),
    blk("bulleted_list_item", rt(text("Better ranking"))),
    blk("numbered_list_item", rt(text("Design"))),
    blk("numbered_list_item", rt(text("Build"))),
    blk("numbered_list_item", rt(text("Launch"))),
    blk("to_do", {**rt(text("Write spec")), "checked": True}),
    blk("to_do", {**rt(text("Review spec")), "checked": False}),
    blk("to_do", {**rt(text("Kickoff")), "checked": True}),
    blk("heading_2", {**rt(text("Timeline")), "is_toggleable": False}),
    blk("table", {"table_width": 2, "has_column_header": True, "has_row_header": False}, [
        blk("table_row", {"cells": [[text("Phase")], [text("Date")]]}),
        blk("table_row", {"cells": [[text("Beta")], [text("Nov 1")]]}),
        blk("table_row", {"cells": [[text("GA")], [text("Dec 1", italic=True)]]}),
    ]),
    blk("code", {"rich_text": [text("print('launch')")], "language": "python", "caption": []}),
    blk("quote", rt(text("Stay focused"))),
    blk("callout", {**rt(text("Remember the launch")), "icon": {"type": "emoji", "emoji": "💡"}}),
    blk("toggle", rt(text("Details")), [para(text("Hidden text"))]),
    blk("divider", {}),
    blk("image", {"type": "external", "external": {"url": "https://example.com/diagram.png"},
                  "caption": [text("Diagram")]}),
    blk("child_page", {"title": "Engineering Wiki"}),
    blk("child_database", {"title": "Tasks"}),
    blk("heading_3", {**rt(text("Notes")), "is_toggleable": False}),
    para(text("Owner: "), mention_user(ADA)),
]
# The child_page block IS the Engineering Wiki page (Notion gives a child page block the page's id).
_wiki_block = next(b for b in ROADMAP_BLOCKS if b["type"] == "child_page")
_wiki_block["id"] = WIKI
_wiki_block["has_children"] = True
_db_block = next(b for b in ROADMAP_BLOCKS if b["type"] == "child_database")
_db_block["id"] = TASKS_DB

WIKI_BLOCKS = [para(text("Wiki home")), blk("bulleted_list_item", rt(text("Onboarding")))]
_wiki_block["_children"] = WIKI_BLOCKS

BLOCK_CHILDREN: dict[str, list] = {ROADMAP: ROADMAP_BLOCKS, WIKI: WIKI_BLOCKS, MEETING: []}


def _index(blocks: list, parent: str) -> None:
    for b in blocks:
        b["parent"] = {"type": "page_id", "page_id": parent} if parent in PAGE_BY_ID else {"type": "block_id", "block_id": parent}
        if b["_children"]:
            BLOCK_CHILDREN[b["id"]] = b["_children"]
            _index(b["_children"], b["id"])


_index(ROADMAP_BLOCKS, ROADMAP)
BLOCK_BY_ID = {}
for _kids in BLOCK_CHILDREN.values():
    for _b in _kids:
        BLOCK_BY_ID[_b["id"]] = _b

PARAGRAPH = ROADMAP_BLOCKS[1]["id"]

# ------------------------------------------------------------------------- comments

COMMENTS = [
    {"object": "comment", "id": nid("f001"), "parent": {"type": "page_id", "page_id": ROADMAP},
     "discussion_id": nid("f0d1"), "created_time": "2026-11-01T10:00:00.000Z",
     "last_edited_time": "2026-11-01T10:00:00.000Z", "created_by": uref(ADA),
     "rich_text": [text("Can we move GA earlier?")], "display_name": {"type": "user", "resolved_name": "Ada Lovelace"},
     "attachments": []},
    {"object": "comment", "id": nid("f002"), "parent": {"type": "page_id", "page_id": ROADMAP},
     "discussion_id": nid("f0d1"), "created_time": "2026-11-01T11:00:00.000Z",
     "last_edited_time": "2026-11-01T11:00:00.000Z", "created_by": uref(GRACE),
     "rich_text": [text("Only if indexing is done.")],
     "display_name": {"type": "user", "resolved_name": "Grace Hopper"},
     "attachments": [{"category": "image", "file": {"url": "https://files.example.com/plan.png",
                                                    "expiry_time": "2026-11-15T13:00:00.000Z"}}]},
    {"object": "comment", "id": nid("f003"), "parent": {"type": "block_id", "block_id": PARAGRAPH},
     "discussion_id": nid("f0d2"), "created_time": "2026-11-02T09:00:00.000Z",
     "last_edited_time": "2026-11-02T09:00:00.000Z", "created_by": uref(LINUS),
     "rich_text": [text("Which quarter?")], "display_name": {"type": "user", "resolved_name": "Linus Torvalds"},
     "attachments": []},
]
