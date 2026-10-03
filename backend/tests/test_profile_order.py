"""R20 设备档案自定义排序验收（PLAN §8.50 ②-3 · 2026-10-03 拍板解禁 DDL）。

钉五件事：

1. **从未重排** → 顺序仍 label 升序、`sort_order` 全 0（**存量行为逐字不变**的回归钉子）；
2. **重排** → 按提交的 id 序落 1..N 稠密序号（单事务），`GET /profiles` 跟着新序走；
3. **四类非法提交**（重复 / 遗漏 / 未知 / 混入回收站）→ 400 且**一个字节都不写**；
4. **路由注册顺序**：`PUT /profiles/order` 必须排在 `PUT /profiles/{profile_id}` 之前
   （否则字面 `order` 被参数路由吃掉，前端拿到的是 404 而不是 400）；
5. **新建档案序号规则**：未重排给 0（照 label 落位），已重排 `max + 1` 追加末尾；
   删中间一条**不重排**其余行的序号（顺序不塌）。

全部跑在临时库上，绝不触碰 `backend/db/yorha.db`。
"""

from fastapi import HTTPException

from backend.db.models import DeviceProfile
from backend.db.soft_delete import mark_deleted
from backend.routers.profile import (
    create_profile,
    delete_profile,
    get_profiles,
    reorder_profiles,
    router,
)
from backend.schemas.profile_api import ProfileCreate, ProfileOrderUpdate
from backend.tests.test_profiles import ProfileTestBase


def _labels(rows):
    return [row.label for row in rows]


def _state(rows):
    """顺序 + 序号的全量快照（坏提交前后必须逐字相同）。"""
    return [(row.id, row.label, row.sort_order) for row in rows]


class ProfileOrderTest(ProfileTestBase):
    def _create(self, label):
        return create_profile(ProfileCreate(label=label), db=self.db)

    def _rows(self):
        return get_profiles(db=self.db)

    # 1 · 回归：从未重排 = 旧的 label ASC，且序号字段恒 0 ---------------------
    def test_never_reordered_keeps_label_ascending_and_zero(self):
        self._create("B档")
        self._create("A档")
        rows = self._rows()
        self.assertEqual(_labels(rows), ["A档", "B档"])
        self.assertEqual([row.sort_order for row in rows], [0, 0])

    # 2 · 重排：1..N 稠密落库，列表与响应都按新序 ----------------------------
    def test_reorder_persists_dense_1_to_n_and_list_follows_it(self):
        first = self._create("A档")
        second = self._create("B档")
        third = self._create("C档")
        self.assertEqual(_labels(self._rows()), ["A档", "B档", "C档"])  # 落位仍是 label 序

        out = reorder_profiles(
            ProfileOrderUpdate(ids=[third.id, first.id, second.id]), db=self.db
        )
        # 返回的就是新顺序，且带上了刚落的序号（前端拿它直接替换本地状态）
        self.assertEqual(_labels(out), ["C档", "A档", "B档"])
        self.assertEqual([row.sort_order for row in out], [1, 2, 3])

        rows = self._rows()
        self.assertEqual(_labels(rows), ["C档", "A档", "B档"])
        self.assertEqual([row.sort_order for row in rows], [1, 2, 3])

        # 再提交一次同样的顺序 → 幂等（号仍是 1..N，不累加成 2..6）
        reorder_profiles(
            ProfileOrderUpdate(ids=[third.id, first.id, second.id]), db=self.db
        )
        self.assertEqual([row.sort_order for row in self._rows()], [1, 2, 3])

    # 3 · 四类非法提交：400 且零写入 -----------------------------------------
    def test_reorder_rejects_bad_id_sets_without_writing(self):
        first = self._create("A档")
        second = self._create("B档")
        third = self._create("C档")

        self._create("回收档")
        trashed = self.db.query(DeviceProfile).filter_by(label="回收档").one()
        mark_deleted(trashed)
        self.db.commit()

        # 先合法重排一次，让序号非 0 —— 坏提交更不可能「碰巧」前后没变化
        reorder_profiles(
            ProfileOrderUpdate(ids=[third.id, second.id, first.id]), db=self.db
        )
        before = _state(self._rows())
        self.assertNotEqual([row.sort_order for row in self._rows()], [0, 0, 0])

        cases = {
            "重复 id": [third.id, third.id, second.id, first.id],
            "遗漏一条": [third.id, second.id],
            "不认识的 id": [third.id, second.id, first.id, "no-such-id"],
            "混入回收站行": [third.id, second.id, first.id, trashed.id],
        }
        for name, ids in cases.items():
            with self.subTest(case=name):
                with self.assertRaises(HTTPException) as ctx:
                    reorder_profiles(ProfileOrderUpdate(ids=ids), db=self.db)
                self.assertEqual(ctx.exception.status_code, 400)
                self.assertTrue(ctx.exception.detail)  # 报清原因，不是裸 400
                self.assertEqual(_state(self._rows()), before)  # 一个字节都没写

    # 4 · 路由注册顺序：字面 `order` 必须排在参数路由之前 --------------------
    def test_literal_order_route_registered_before_path_param(self):
        put_paths = [
            route.path
            for route in router.routes
            if "PUT" in (route.methods or set())
        ]
        self.assertIn("/profiles/order", put_paths)
        self.assertIn("/profiles/{profile_id}", put_paths)
        self.assertLess(
            put_paths.index("/profiles/order"),
            put_paths.index("/profiles/{profile_id}"),
            "PUT /profiles/order 必须先于 PUT /profiles/{profile_id} 注册",
        )

    # 5 · 新建档案的序号规则 --------------------------------------------------
    def test_new_profile_sort_order_rules(self):
        # 从未重排 → 0，继续按 label 落位（存量插入行为不变）
        self._create("B档")
        fresh = self._create("A档")
        self.assertEqual(fresh.sort_order, 0)
        self.assertEqual(_labels(self._rows()), ["A档", "B档"])

        ids = [row.id for row in self._rows()]
        reorder_profiles(ProfileOrderUpdate(ids=ids), db=self.db)  # A=1, B=2

        added = self._create("C档")
        self.assertEqual(added.sort_order, 3)  # max(1,2) + 1
        # 已有自定义序 → 追到末尾（0 会把它顶到最前面，那才是 bug）
        self.assertEqual(_labels(self._rows()), ["A档", "B档", "C档"])

    # 6 · 删中间一条不重排其余序号（顺序不塌） --------------------------------
    def test_delete_middle_profile_keeps_others_order(self):
        first = self._create("A档")
        second = self._create("B档")
        third = self._create("C档")
        reorder_profiles(
            ProfileOrderUpdate(ids=[third.id, first.id, second.id]), db=self.db
        )

        delete_profile(second.id, db=self.db)
        rows = self._rows()
        self.assertEqual(_labels(rows), ["C档", "A档"])  # 1,2 原样留着
        self.assertEqual([row.sort_order for row in rows], [1, 2])
        self.assertIsInstance(rows[0].sort_order, int)  # 响应仍带序号字段
