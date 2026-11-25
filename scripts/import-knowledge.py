"""Import the two final sheets in the team's competition ZIP using Python 3."""
import argparse
import hashlib
import io
import json
import os
import posixpath
import re
import tempfile
import xml.etree.ElementTree as ET
import zipfile
from pathlib import Path


def cells(book, title):
    workbook = ET.fromstring(book.read("xl/workbook.xml"))
    sheet = next((s for s in workbook.findall(".//{*}sheet") if s.get("name") == title), None)
    if sheet is None:
        return {}
    rel_id = sheet.get("{http://schemas.openxmlformats.org/officeDocument/2006/relationships}id")
    rels = ET.fromstring(book.read("xl/_rels/workbook.xml.rels"))
    target = next(r.get("Target") for r in rels if r.get("Id") == rel_id)
    root = ET.fromstring(book.read(posixpath.normpath(posixpath.join("xl", target)).lstrip("/")))
    shared = []
    if "xl/sharedStrings.xml" in book.namelist():
        shared = ["".join(s.itertext()).strip() for s in ET.fromstring(book.read("xl/sharedStrings.xml"))]
    table = {}
    for cell in root.findall(".//{*}sheetData/{*}row/{*}c"):
        value = cell.findtext("{*}v") or ""
        if cell.get("t") == "s":
            value = shared[int(value)]
        if cell.get("t") == "inlineStr":
            value = "".join(t.text or "" for t in cell.findall(".//{*}t"))
        if value.strip():
            table[cell.get("r")] = value.strip()
    # Only copy actual vertical merges. Blank unmerged cells stay blank.
    for merge in root.findall(".//{*}mergeCell"):
        m = re.fullmatch(r"([A-E])(\d+):\1(\d+)", merge.get("ref", ""))
        if m:
            col, start, end = m.groups()
            for row in range(int(start) + 1, int(end) + 1):
                table[col + str(row)] = table.get(col + start, "")
    return table


def records(table, headings):
    rows = sorted({int(re.search(r"\d+", key)[0]) for key in table})
    def values(row):
        return [table.get(chr(65 + col) + str(row), "") for col in range(len(headings))]
    header = next(row for row in rows if values(row) == headings)
    for row in rows:
        fields = values(row)
        if row > header and any(fields):
            if not all(fields):
                raise ValueError(f"第 {row} 行缺少必要字段")
            yield row, fields


def load_package(path):
    scenarios, faq = [], []
    with zipfile.ZipFile(path) as package:
        for name in package.namelist():
            if name.startswith("__MACOSX/") or not name.lower().endswith(".xlsx"):
                continue
            content = package.read(name)
            with zipfile.ZipFile(io.BytesIO(content)) as book:
                for title, headings in [("场景汇总", ["一级菜单", "一级分类", "二级分类", "关单方式"]),
                                        ("高频QA", ["模块", "商家问题", "客服回答"])]:
                    table = cells(book, title)
                    if not table:
                        continue
                    for row, fields in records(table, headings):
                        source = dict(sheet=title, row=row, sha256=hashlib.sha256(content).hexdigest())
                        if title == "场景汇总":
                            *categories, method = fields
                            if method not in ("电话", "京麦驳回"):
                                raise ValueError(f"第 {row} 行关单方式未知")
                            scenarios.append(dict(categories=categories, method=method, source=source))
                        else:
                            module, question, answer = fields
                            faq.append(dict(module=module, question=question, answer=answer, source=source))
    if not scenarios or not faq or len({tuple(s["categories"]) for s in scenarios}) != len(scenarios):
        raise ValueError("缺少定稿场景、问答表或场景分类键重复")
    return dict(version=1, scenarios=scenarios, faq=faq)


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("package", type=Path)
    parser.add_argument("--output", type=Path, default=Path(__file__).resolve().parents[1] / "data/knowledge.json")
    args = parser.parse_args()
    catalog = load_package(args.package)
    args.output.parent.mkdir(exist_ok=True, parents=True)
    with tempfile.NamedTemporaryFile(mode="w", encoding="utf-8", delete=False, dir=args.output.parent) as f:
        json.dump(catalog, f, ensure_ascii=False, indent=2)
    os.replace(f.name, args.output)
    print(f"已导入 {len(catalog['scenarios'])} 条场景、{len(catalog['faq'])} 条问答。")
