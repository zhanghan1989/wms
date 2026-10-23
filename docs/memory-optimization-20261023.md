# 内存优化记录（2026-10-23，日本时间）

生产云助手任务 t-gz070w10j8puz28 于17:09成功执行：临时将 vm.swappiness 从0调为10，未重启服务。即时可用内存377 MiB，1 GiB swap使用为0，后两次vmstat采样换入换出均为0，iowait为0。短时采样不代表业务高峰验证完成。

原有零值配置存在于 /etc/sysctl.conf、/etc/sysctl.d/99-sysctl.conf 和 /etc/sysctl.d/99-apsara-sysctl.conf。当前只调整运行值，重启可能恢复为0；需经过部署和库存同步高峰验证后再持久化。回滚运行值：sysctl -w vm.swappiness=0。

MySQL只读核查：innodb_buffer_pool_size=128 MiB，max_connections=151，max_heap_table_size和tmp_table_size均16 MiB，Max_used_connections=5，Threads_connected=4。未调整数据库参数；当前资料不足以解释全部RSS，不按RSS直接压低缓冲池。

代码增加部署阶段资源检查：镜像导入和迁移前要求MemAvailable至少300 MiB，memory和io的full avg60均低于10%。不满足时终止本次发布，需资源恢复后重新执行；检查不预留内存，也不能排除检查后新任务启动。

商品清单原本已限制每页25件，本次保留。增加乐天库存响应解析后的RSS、堆、外部分配和堆变化记录；变化包含同一进程其他请求，并非精确单任务峰值。

产品、SKU、入库、组合产品、返品Excel入口限制单文件20 MiB。返品额外限制10000行，解析最多10002行（含表头和用于检测超限的一行），超限在写入前拒绝。压缩文件大小不等于解压后内存上限。

尚未实现跨部署、备份、导入和同步的统一任务互斥；备份保持现有分批和流式实现。未扩容、未扩大Swap、未设置数据库容器硬内存上限。
