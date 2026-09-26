from services.sandbox import same_version, whole_seconds


def test_restored_snapshot_is_not_redelivered():
    # 交付时 find 报的是亚秒时间，tar 恢复后只剩整秒：同一版文件不能当成新改的
    recorded = [633516, "1758782000.4213567890"]
    assert same_version(recorded, (633516, "1758782000.0000000000"))
    assert same_version([633516, whole_seconds("1758782000.42")], (633516, "1758782000.0000000000"))


def test_real_changes_are_delivered():
    assert not same_version([633516, "1758782000"], (634345, "1758782000.0"))
    assert not same_version([633516, "1758782000"], (633516, "1758782061.5"))
    assert not same_version(None, (1, "1"))
