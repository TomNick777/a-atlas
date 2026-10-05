"""V3 EVAL-ONLY topic families: retrieval benchmark + ranking benchmark + negation set.

Isolation contract: nothing in this file (family or query text) may be used in any
V3 training set. TRAIN uses topics_train.py (+adjacent-theme additions built later).

Label discipline, same as topics.py: rules read profile text (hay) and every level-3/2/1
must quote its matched span. Curated entries that rely on real-world product-line facts
the filing text does not carry are marked `EXTERNAL` in the evidence — they are honest
ground truth for judging, and each says so. None=missing data, not guessed.

The 20 acceptance queries (Q01-Q20) appear VERBATIM here for the Phase H rerun; they
carry no internal label authority — external referees judge the rerun. The internal
ranking benchmark uses the paraphrases + rules.
"""

from __future__ import annotations

from .data import hay, match_text, ov
from .topics import (
    AICOMP_HW_PAT,
    COPPER_PAT,
    DC_PAT,
    PARTS_UP_PAT,
    ROBOT_PAT,
    SEM_PAT,
    TEST_TOPICS,
    _rule,
)
from .topics_train import overseas_of

_BY_FAMILY = {t["family"]: t for t in TEST_TOPICS}

# 真实机器人整机/本体厂 —— "不要整机厂" 的排除对象
ROBOT_OEM_PAT = r"工业机器人(本体|整机|制造|生产|销售)|机器人及智能制造系统|机器人产品及系统|机器人系统集成|智能机器人(及|、|,)|人形机器人、四足机器人|通用人形机器人|具身智能模型的研发"


def _reused(family: str, extra_curated: dict | None = None) -> dict:
    """A V3 eval family reusing a TEST family's label verbatim."""
    base = _BY_FAMILY[family]
    curated = dict(base.get("curated") or {})
    if extra_curated:
        curated.update(extra_curated)
    return {"label": base["label"], "curated": curated}


EV_FAMILIES: list[dict] = [
    {
        "family": "EV-CHAIN-DC-LIQCOOL",
        "category": "产业链",
        "queries": [
            "给数据中心做液冷散热的公司",
            "主营业务和服务器散热、机房温控、液冷有关的公司",
            "服务器液冷散热方案厂商",
        ],
        # 不同于 TEST 的 T-CHAIN-DCCL(主题宽口径):这里 query 明确是数据中心散热,
        # 裸词"液冷"一提不算 3;汽车热管理为主的公司是 hard negative(1),不是 2。
        "label": lambda c: (
            lambda strong, thermal, carthermal: None
            if not strong and not thermal and not carthermal
            else (3, f"DC液冷/温控:{strong}")
            if strong
            else (1, f"汽车热管理为主(非机房):{carthermal}")
            if carthermal and not thermal
            else (2, f"热管理/散热/制冷:{thermal}")
        )(
            match_text(
                c,
                r"液冷(产品|系统|设备|方案|解决方案|技术|温控|板|机组)|液体恒温|纯水冷却|冷板式|浸没式|精密温控|机房温控|机房空调|数据中心.{0,8}(温控|制冷|散热|冷却)|电子(级)?散热",
            ),
            match_text(c, r"制冷|散热|热管理|热能动力|温控|换热|冷却"),
            match_text(c, r"汽车热管理|车用空调|车载空调|车辆空调|汽车(空调|换热|冷却)"),
        ),
        "curated": {
            "300990": (3, "同飞股份:液体恒温设备、纯水冷却单元(液冷温控设备)"),
            "301018": (3, "申菱环境:专业特种空调和温控设备(数据中心温控主业)"),
            "300499": (3, "高澜股份:大功率电力电子热管理(含数据中心散热场景;EXTERNAL)"),
            "920808": (3, "曙光数创:数据中心液冷基础设施"),
            "002239": (1, "奥特佳:汽车热管理+储能热管理(非机房)"),
            "002126": (1, "银轮股份:热管理产品(车用为主)"),
            "002454": (1, "松芝股份:移动式热管理(车载)"),
            "002592": (1, "ST八菱:汽车热管理(车载)"),
            "002639": (2, "雪人集团:热能动力/制冷压缩机,产品含数据中心冷却系统集成"),
            "002179": (2, "中航光电:流体连接技术(液冷接头相关)"),
        },
    },
    {
        "family": "EV-NEG-COPPER-RESOURCE",
        "category": "否定",
        "queries": [
            "铜价上涨可能直接受益的资源类公司，不要铜加工企业",
            "如果铜涨价谁最受益",
            "拥有铜矿资源的公司，排除做铜材加工的",
        ],
        "label": lambda c: (
            lambda resource, process: None
            if not resource and not process
            else (3, f"铜资源:{resource}")
            if resource
            else (0, f"铜加工/铜材,查询排除:{process}")
        )(
            match_text(c, r"铜矿|铜金属|铜的采选|铜采选|铜冶炼|阴极铜|铜铅锌|铜钴|铜精矿|铜板块"),
            match_text(c, r"铜管|铜棒|铜箔|铜杆|铜线|铜板带|铜材|铜合金|覆铜板|铜基材料|铜散热器|铜阀"),
        ),
        "curated": {
            "000630": (3, "铜陵有色:铜采选冶炼一体化"),
            "600362": (3, "江西铜业:铜的采、选、冶炼(资源+冶炼)"),
            "601899": (3, "紫金矿业:金、铜、锌矿产资源勘探开发"),
            "601168": (3, "西部矿业:铜铅锌资源采选冶炼"),
            "603993": (3, "洛阳钼业:钼钨及铜钴资源开采"),
            "000060": (3, "中金岭南:铜铅锌采选冶"),
            "000737": (3, "北方铜业:铜开采选矿冶炼"),
            # 同类不同种 HARDNEG:资源/矿业公司但主品种不是铜 —— 字面很像、语义不符。
            # 首轮 V3 盲测把「资源类」泛化成所有矿业(金/锂矿排到铜公司前),这组是对比数据。
            "000506": (0, "HARDNEG:招金黄金,金矿为主,非铜资源"),
            "001337": (0, "HARDNEG:四川黄金,金矿开采,非铜资源"),
            "000975": (0, "HARDNEG:山金国际,贵金属矿为主,铜仅贸易"),
            "600489": (0, "HARDNEG:中金黄金,金矿为主,非铜资源"),
            "600547": (0, "HARDNEG:山东黄金,金矿为主,非铜资源"),
            "600988": (0, "HARDNEG:赤峰黄金,金矿为主,非铜资源"),
            "002155": (0, "HARDNEG:湖南黄金,黄金+锑矿,非铜资源"),
            "002460": (0, "HARDNEG:赣锋锂业,锂资源,非铜资源"),
            "002466": (0, "HARDNEG:天齐锂业,锂资源,非铜资源"),
            "000960": (0, "HARDNEG:锡业股份,锡铅锌铟为主(铜为辅,非铜资源股)"),
            "000426": (0, "HARDNEG:兴业银锡,银锡矿,非铜资源"),
            "000603": (0, "HARDNEG:盛达资源,银铅锌矿,非铜资源"),
            "000688": (0, "HARDNEG:国城矿业,有色采选(锌硫为主),非铜资源"),
            # 铜加工 = 查询明确排除的对象(known_excludes)
            "002171": (0, "楚江新材:铜基材料加工,查询明确排除"),
            "002203": (0, "海亮股份:铜管加工,查询明确排除"),
            "002295": (0, "精艺股份:铜管/铜杆/铜线加工,查询明确排除"),
            "601609": (0, "金田股份:铜加工产品,查询明确排除"),
            "601137": (0, "博威合金:铜合金材料,查询明确排除"),
            "301217": (0, "铜冠铜箔:铜箔(铜加工),查询明确排除"),
            "600110": (0, "诺德股份:锂电铜箔(铜加工),查询明确排除"),
            "688388": (0, "嘉元科技:锂电铜箔(铜加工),查询明确排除"),
            "000823": (0, "超声电子:覆铜板(铜深加工下游),查询明确排除"),
        },
    },
    {
        "family": "EV-NEG-AIHW-NOSOFT",
        "category": "否定",
        "queries": [
            "AI 算力相关的硬件公司，但不要纯软件公司",
            "算力硬件制造商,排除纯软件企业",
        ],
        "label": lambda c: (
            lambda hw, hwloose, soft: None
            if not hw and not hwloose and not soft
            else (3, f"算力硬件:{hw}")
            if hw
            else (2, f"广义硬件:{hwloose}")
            if hwloose
            else (0, f"纯软件/AI应用,查询排除:{soft}")
        )(
            match_text(c, AICOMP_HW_PAT + r"|GPU|存储器|交换机"),
            match_text(c, r"服务器电源|印制电路板|PCB|连接器|机柜|电源"),
            match_text(c, r"软件(开发|服务|销售)|信息技术服务|人工智能应用|大模型"),
        ),
        "curated": {
            "000977": (3, "浪潮信息:AI服务器整机"),
            "601138": (3, "工业富联:云计算服务器代工"),
            "300308": (3, "中际旭创:光模块"),
            "002415": (0, "海康威视:智能物联方案(软件+硬件,非算力硬件)"),
            "002230": (0, "科大讯飞:AI软件/平台,查询明确排除"),
            "688111": (0, "金山办公:办公软件,查询明确排除"),
            "300454": (0, "深信服:网络安全软件为主,查询明确排除"),
        },
    },
    {
        "family": "EV-FUZZ-LIKEHC2",
        "category": "模糊",
        "queries": [
            "类似汇川技术：工业自动化、伺服、控制器、电机这些方向的公司",
            "类似汇川技术但规模更小的公司",
            "做伺服驱动、运动控制、自动化控制器的企业",
        ],
        **_reused("T-FUZZ-LIKEHC"),
    },
    {
        "family": "EV-NEG-HUMANOID-PARTS",
        "category": "否定",
        "queries": [
            "人形机器人上游核心零部件，但不要整机厂",
            "人形机器人核心零部件供应商,排除机器人本体厂",
        ],
        "label": lambda c: (
            lambda part, partloose, oem: None
            if not part and not partloose and not oem
            else (0, f"机器人整机/本体厂,查询排除:{oem}")
            if oem and not part and not partloose
            else (3, f"机器人核心零部件:{part}")
            if part
            else (2, f"广义零部件:{partloose}")
            if partloose
            else (1, f"机器人整机厂,查询排除:{oem}")
        )(
            match_text(c, r"减速器|滚珠丝杠|行星滚柱丝杠|丝杠|空心杯|谐波|精密传动|机器人零部件|机器人核心功能部件|机器人关节|微型传动|控制电机|步进电机|伺服系统|伺服电机|伺服驱动|编码器|运动控制|线性驱动|驱动系统|执行机构|六维力|触觉传感器|电子皮肤"),
            match_text(c, r"伺服|执行器|电机|传动|轴承|传感器"),
            match_text(c, ROBOT_OEM_PAT),
        ),
        "curated": {
            "688017": (3, "绿的谐波:谐波减速器"),
            "002472": (3, "双环传动:齿轮(机器人关节减速器)"),
            "002896": (3, "中大力德:减速器"),
            "300503": (3, "昊志机电:机器人核心功能部件"),
            "603667": (3, "五洲新春:产品列有机器人零部件(轴承/丝杠)"),
            "603728": (3, "鸣志电器:控制电机(空心杯电机厂商)"),
            "003021": (3, "兆威机电:微型传动系统"),
            "688165": (2, "埃夫特:自称核心底层技术及零部件,但主体是整机+集成"),
            "002747": (1, "埃斯顿:整机为主,兼运动控制部件(查询排除整机厂)"),
            "002527": (1, "新时达:机器人产品及系统(整机/集成,查询排除)"),
            "300024": (0, "机器人(新松):本体+系统集成,查询明确排除"),
        },
    },
    {
        "family": "EV-CHAIN-DEXHAND",
        "category": "产业链",
        "queries": [
            "机器人灵巧手可能需要的电机、传动、传感器公司",
            "灵巧手核心部件供应商(微型电机、传动、力传感器)",
        ],
        "label": lambda c: _rule(
            c,
            r"微型传动|空心杯|控制电机|步进电机|伺服系统|伺服电机|编码器|六维力|力传感器|触觉传感器|柔性传感器|微型电机|精密齿轮|微型减速",
            hit=3,
        )
        or _rule(c, r"电机|传动|传感器", hit=2)
        or _rule(c, ROBOT_PAT, hit=1),
        "curated": {},
    },
    {
        "family": "EV-IND-SEM-EQUIP2",
        "category": "否定",
        "queries": [
            "国产半导体设备公司",
            "半导体国产替代里真正卖生产设备的公司，不要芯片设计公司",
            "半导体设备,排除芯片设计",
        ],
        "label": lambda c: (
            lambda equip, chipdesign: None
            if not equip and not chipdesign
            else (3, f"半导体设备:{equip}")
            if equip
            else (0, f"芯片设计,查询排除:{chipdesign}")
        )(
            match_text(c, r"半导体(设备|装备|专用设备|专用装备)|集成电路(专用)?设备|电子工艺装备|晶圆制造设备"),
            match_text(c, r"芯片设计|集成电路设计|IP核|EDA"),
        ),
        "curated": {
            "002371": (3, "北方华创:电子工艺装备(半导体设备)"),
            "688012": (3, "中微公司:高端半导体设备"),
            "688981": (0, "中芯国际:晶圆代工(设备使用方,非设备商)"),
            "688347": (0, "华虹宏力:晶圆代工(设备使用方)"),
            "300054": (1, "鼎龙股份:半导体材料(非设备)"),
            "600584": (1, "长电科技:封测(设备采购方)"),
        },
    },
    {
        "family": "EV-IND-SEM-PROCESS",
        "category": "行业",
        "queries": [
            "专门做半导体清洗、刻蚀或者薄膜沉积设备的公司",
            "做刻蚀设备的公司",
            "半导体薄膜沉积设备厂商",
        ],
        "label": lambda c: _rule(
            c,
            r"刻蚀|薄膜沉积|沉积设备|清洗设备|湿法工艺|涂胶显影|化学气相沉积|物理气相沉积|CVD|PVD|ALD|CMP设备|去胶|氧化扩散|炉管",
            hit=3,
        )
        or _rule(c, r"半导体(专用)?(设备|装备)", hit=2)
        or _rule(c, SEM_PAT, hit=1),
        "curated": {
            # 档案文字只写"半导体专用设备",工艺类型来自公开产品线 —— EXTERNAL 标注
            "688012": (3, "EXTERNAL:中微公司主营刻蚀设备(档案仅写半导体设备)"),
            "002371": (3, "EXTERNAL:北方华创覆盖刻蚀/薄膜沉积/清洗/炉管(档案仅写电子工艺装备)"),
            "688072": (3, "EXTERNAL:拓荆科技主营薄膜沉积(PECVD/ALD)"),
            "688082": (3, "EXTERNAL:盛美上海主营清洗设备"),
            "688120": (3, "EXTERNAL:华海清科主营CMP设备"),
            "688037": (3, "EXTERNAL:芯源微主营涂胶显影设备"),
            "603690": (3, "至纯科技:湿法工艺设备(清洗),档案文字直接可证"),
            "300604": (1, "长川科技:测试机/分选机(测试设备,非工艺设备)"),
            "300567": (1, "精测电子:检测系统(量测,非工艺设备)"),
        },
    },
    {
        "family": "EV-COMBO-AUTO-EXPORT",
        "category": "组合",
        "queries": [
            "做消费电子精密零部件，同时有大量海外客户的公司",
            "消费电子精密零部件出口企业",
        ],
        **_reused("T-COMBO-CE-EXPORT"),
    },
    {
        "family": "EV-COMBO-INDAUTO-EXPORT",
        "category": "组合",
        "queries": [
            "做工业自动化，同时海外业务比较多的公司",
            "工业自动化产品出口企业",
        ],
        "label": lambda c: (
            lambda auto, s: None
            if not auto and s is None
            else (3, f"工业自动化:{auto};境外{s}%")
            if auto and s is not None and s >= 25
            else (2, f"工业自动化:{auto}" + (f",境外仅{s}%" if s is not None else ""))
            if auto
            else (1, f"海外{s}%但非工业自动化")
            if s is not None and s >= 25
            else None
        )(
            match_text(c, r"工业自动化|伺服系统|变频器|运动控制|PLC|控制系统|自动化核心部件"),
            overseas_of(c),
        ),
        "curated": {
            "300124": (2, "汇川技术:工业自动化龙头,境外占比低"),
            "002979": (2, "雷赛智能:运动控制,境外有限"),
        },
    },
    {
        "family": "EV-ATTR-OVERSEAS2",
        "category": "属性",
        "queries": [
            "主要靠海外市场赚钱的中国制造业公司",
        ],
        **_reused("T-ATTR-OVERSEAS"),
    },
    {
        "family": "EV-NEG-NEVMAT2",
        "category": "否定",
        "queries": [
            "新能源汽车上游材料公司，但不要整车厂",
            "真正做新能源汽车电池材料的公司，不要因为投资了新能源项目就算",
        ],
        "label": lambda c: (
            lambda mat, oem: None
            if mat is None and oem is None
            else (0, f"整车厂,查询排除:{oem}")
            if oem
            else (mat[0], mat[1])
        )(
            _BY_FAMILY["T-CHAIN-NEVMAT"]["label"](c),
            match_text(c, r"整车|乘用车|商用车|轿车|SUV|客车|汽车制造"),
        ),
        "curated": {},
    },
    {
        "family": "EV-NEG-AIDC-NOALGO",
        "category": "否定",
        "queries": [
            "AI 数据中心建设会需要的基础设施公司，不要大模型软件公司",
            "AI数据中心基础设施(供电/制冷/机柜/网络),排除大模型和算法公司",
        ],
        "label": lambda c: (
            lambda infra, infra2, algo: None
            if not infra and not infra2 and not algo
            else (0, f"大模型/算法/AI软件,查询排除:{algo}")
            if algo and not infra and not infra2
            else (3, f"AIDC基础设施:{infra}")
            if infra
            else (2, f"广义配套:{infra2}")
            if infra2
            else (1, f"大模型/AI软件,查询排除:{algo}")
        )(
            match_text(c, r"数据中心|IDC|互联网数据中心|机房|算力|智算|液冷|精密温控|供配电|高压直流|HVDC|UPS|不间断电源|服务器"),
            match_text(c, r"光模块|交换机|印制电路板|PCB|机柜|电源|连接器"),
            match_text(c, r"大模型|算法|人工智能软件|AI应用|软件(开发|服务|销售)|信息技术服务|互联网信息服务"),
        ),
        "curated": {
            "002364": (3, "中恒电气:数据中心电源(软件为电力数字化,非大模型)"),
            "300290": (1, "荣科科技:IT服务为主,AIDC沾边"),
        },
    },
    {
        "family": "EV-CHAIN-DC-POWER",
        "category": "产业链",
        "queries": [
            "给数据中心做供配电、UPS、电源保障的公司",
            "数据中心电源设备厂商",
            "UPS不间断电源企业",
        ],
        "label": lambda c: _rule(
            c,
            r"UPS|不间断电源|数据中心.{0,8}(电源|供配电|配电)|电源保障|高压直流|HVDC|通信电源|智慧电能",
            hit=3,
        )
        or _rule(c, r"电源(产品|系统|设备|管理)?|供配电|配电设备", hit=2)
        or _rule(c, DC_PAT, hit=1),
        "curated": {
            "002518": (3, "科士达:UPS及数据中心产品"),
            "300376": (3, "易事特:UPS电源、数据中心"),
            "002335": (3, "科华数据:数据中心产品+智慧电能(UPS龙头之一)"),
            "300870": (3, "欧陆通:数据中心电源(服务器电源)"),
            "002364": (3, "中恒电气:数据中心电源、通信电源"),
            "600405": (3, "动力源:通信电源、模块电源"),
            "002851": (2, "麦格米特:电源是板块之一(多业务)"),
            "300693": (2, "盛弘股份:工业配套电源,数据中心电能保障为领域之一"),
            "002334": (2, "英威腾:网络能源/数据中心是四大板块之一"),
            "603063": (2, "禾望电气:电能变换(新能源电控为主,数据中心有限)"),
        },
    },
    {
        "family": "EV-FUZZ-AISHOVEL2",
        "category": "模糊",
        "queries": [
            "给 AI 卖铲子的公司",
        ],
        **_reused("T-FUZZ-SHOVEL"),
    },
    {
        "family": "EV-FUZZ-ROBOTUP2",
        "category": "模糊",
        "queries": [
            "机器人时代可能最先赚钱的零部件公司",
        ],
        **_reused("T-FUZZ-ROBOTUP"),
    },
    {
        "family": "EV-CHAIN-ROBOTPARTS2",
        "category": "产业链",
        "queries": [
            "做机器人减速器、伺服、电机这些核心零部件的公司",
            "机器人核心零部件(减速器/电机/丝杠)供应商",
        ],
        "label": lambda c: (
            lambda part, partloose, oem: None
            if not part and not partloose and not oem
            else (1, f"机器人本体厂(零部件沾边):{oem}")
            if oem and not part and not partloose
            else (3, f"机器人核心零部件:{part}")
            if part
            else (2, f"广义零部件:{partloose}")
            if partloose
            else (1, f"机器人厂商:{oem}")
        )(
            match_text(c, r"减速器|滚珠丝杠|行星滚柱丝杠|丝杠|空心杯|谐波|精密传动|机器人零部件|机器人核心功能部件|机器人关节|微型传动|控制电机|步进电机|伺服系统|伺服电机|伺服驱动|编码器|运动控制|线性驱动|驱动系统|执行机构"),
            match_text(c, r"伺服|执行器|电机|传动|轴承|传感器"),
            match_text(c, ROBOT_OEM_PAT),
        ),
        "curated": {
            "300024": (1, "机器人(新松):本体+集成,零部件非对外供应主业"),
        },
    },
    {
        "family": "EV-IND-ROBOT2",
        "category": "行业",
        "queries": [
            "工业机器人相关，但不要只因为“机器人概念”就算进去",
        ],
        **_reused("T-IND-ROBOT"),
    },
    {
        "family": "EV-CHAIN-APPLE",
        "category": "产业链",
        "queries": [
            "主营和苹果产业链有关，但不是手机品牌公司的公司",
        ],
        # 档案无客户字段、concepts 全空 —— 本 family 仅收录 EXTERNAL curated(公开供应链常识),
        # 规则不猜。内部排名基准不计分,只进 Phase H 复跑(外部裁判评)。
        "label": lambda c: None,
        "external_only": True,
        "curated": {
            "002475": (3, "EXTERNAL:立讯精密为苹果核心代工/零组件供应商(档案无客户字段)"),
            "002241": (3, "EXTERNAL:歌尔股份为苹果声学/硬件供应商"),
            "300433": (3, "EXTERNAL:蓝思科技为苹果玻璃盖板供应商"),
            "002384": (3, "EXTERNAL:东山精密为苹果FPC供应商"),
            "002600": (3, "EXTERNAL:领益智造为苹果结构件供应商"),
            "002938": (3, "EXTERNAL:鹏鼎控股为苹果PCB主力供应商"),
            "002273": (3, "EXTERNAL:水晶光电为苹果光学元器件供应商"),
            "300115": (3, "EXTERNAL:长盈精密为苹果精密零组件供应商"),
            "300136": (2, "EXTERNAL:信维通信曾供应苹果天线/无线充电(份额有波动)"),
        },
    },
]

# ---- query registry ----------------------------------------------------------

ACCEPTANCE_QUERIES = {
    "给数据中心做液冷散热的公司": "Q02",
    "主营业务和服务器散热、机房温控、液冷有关的公司": "Q20",
    "AI 算力相关的硬件公司，但不要纯软件公司": "Q03",
    "铜价上涨可能直接受益的资源类公司，不要铜加工企业": "Q05",
    "人形机器人上游核心零部件，但不要整机厂": "Q01",
    "做工业自动化，同时海外业务比较多的公司": "Q04",
    "做消费电子精密零部件，同时有大量海外客户的公司": "Q11",
    "国产半导体设备公司": "Q07",
    "专门做半导体清洗、刻蚀或者薄膜沉积设备的公司": "Q08",
    "机器人灵巧手可能需要的电机、传动、传感器公司": "Q17",
    "半导体国产替代里真正卖生产设备的公司，不要芯片设计公司": "Q18",
    "主要靠海外市场赚钱的中国制造业公司": "Q19",
    "类似汇川技术：工业自动化、伺服、控制器、电机这些方向的公司": "Q16",
    "AI 数据中心建设会需要的基础设施公司，不要大模型软件公司": "Q14",
    "新能源汽车上游材料公司，但不要整车厂": "Q06",
    "真正做新能源汽车电池材料的公司，不要因为投资了新能源项目就算": "Q15",
    "给数据中心做供配电、UPS、电源保障的公司": "Q10",
    "主营和苹果产业链有关，但不是手机品牌公司的公司": "Q12",
    "做机器人减速器、伺服、电机这些核心零部件的公司": "Q09",
    "工业机器人相关，但不要只因为“机器人概念”就算进去": "Q13",
}


def ev_queries() -> list[dict]:
    out = []
    for fam in EV_FAMILIES:
        for qi, query in enumerate(fam["queries"]):
            out.append(
                {
                    "query_id": f"{fam['family']}::q{qi}",
                    "family": fam["family"],
                    "category": fam["category"],
                    "query": query,
                    "acceptance_id": ACCEPTANCE_QUERIES.get(query),
                }
            )
    return out
