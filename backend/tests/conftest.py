"""
conftest.py — pytest 自动加载
设置 sys.path 和 services 模块隔离
"""

import os
import sys
import types

# 确保 backend 目录在 sys.path
_backend_dir = os.path.abspath(os.path.join(os.path.dirname(__file__), ".."))
if _backend_dir not in sys.path:
    sys.path.insert(0, _backend_dir)

# tests 目录也加入（让 helpers.py 可 import）
_tests_dir = os.path.dirname(__file__)
if _tests_dir not in sys.path:
    sys.path.insert(0, _tests_dir)

# 阻止 services/__init__.py 的重量级导入（boto3 等）
if "services" not in sys.modules:
    mod = types.ModuleType("services")
    mod.__path__ = [os.path.join(_backend_dir, "services")]
    sys.modules["services"] = mod
