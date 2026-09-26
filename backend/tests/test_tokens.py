from services.tokens import count_prompt, count_text, reasoning_tokens_of, strip_injected


def test_count_matches_upstream_without_injection():
    # 2026-09 实测：gpt-6-astra 没被中转注入时，这个请求上游报 312
    messages = [{"role": "system", "content": "You are a helpful assistant. " * 50}, {"role": "user", "content": "hi"}]
    assert abs(count_prompt(messages) - 312) <= 3


def test_count_includes_tools_images_and_tool_calls():
    base = count_prompt([{"role": "user", "content": "hi"}])
    tool = {"type": "function", "function": {"name": "shell", "description": "run", "parameters": {"type": "object"}}}
    assert count_prompt([{"role": "user", "content": "hi"}], [tool]) > base
    with_image = [{"role": "user", "content": [{"type": "text", "text": "hi"}, {"type": "image_url", "image_url": {"url": "x"}}]}]
    assert count_prompt(with_image) >= base + 700
    call = [{"role": "assistant", "content": None, "tool_calls": [{"function": {"name": "shell", "arguments": '{"command": "ls -la"}'}}]}]
    assert count_prompt(call) > count_prompt([{"role": "assistant", "content": None}])


def test_injected_prefix_comes_out_of_cache_first():
    raw = {"prompt_tokens": 4400, "completion_tokens": 10, "prompt_tokens_details": {"cached_tokens": 4200}}
    billed = strip_injected(raw, own_prompt=300)
    assert billed["prompt_tokens"] == 300
    assert billed["prompt_tokens_details"]["cached_tokens"] == 100
    assert billed["injected_tokens"] == 4100
    assert raw["prompt_tokens"] == 4400  # 不改原对象


def test_uncached_injection_leaves_only_own_prompt_as_new_input():
    billed = strip_injected({"prompt_tokens": 4400, "prompt_tokens_details": {"cached_tokens": 0}}, own_prompt=300)
    assert billed["prompt_tokens"] == 300
    assert billed["prompt_tokens_details"]["cached_tokens"] == 0


def test_no_injection_or_unknown_usage_is_untouched():
    raw = {"prompt_tokens": 300, "prompt_tokens_details": {"cached_tokens": 0}}
    assert strip_injected(raw, own_prompt=320) is raw
    assert strip_injected(None, own_prompt=300) is None
    assert strip_injected(raw, own_prompt=None) is raw


def test_reasoning_tokens_from_usage():
    assert reasoning_tokens_of({"completion_tokens_details": {"reasoning_tokens": 301}}) == 301
    assert reasoning_tokens_of({"output_tokens_details": {"reasoning_tokens": 5}}) == 5
    assert reasoning_tokens_of({"completion_tokens": 3}) is None
    assert count_text("你好世界") >= 2


def test_delivery_preference_defaults_to_quality():
    from services.tool_contracts import delivery_preference

    assert "LaTeX" in delivery_preference(None)
    assert delivery_preference("quality") == delivery_preference("bogus")
    assert "pptxgenjs" in delivery_preference("editable")
