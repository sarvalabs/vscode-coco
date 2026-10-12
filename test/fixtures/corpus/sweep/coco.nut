[coco]
version = "0.9.3"

[module]
name = "SweepTest"
version = "0.0.2"
license = []
repository = ""
authors = []

[target]
os = "MOI"
arch = "PISA"

[target.moi]
format = "YAML"
output = "sweep"

[target.pisa]
format = "ASM"
version = "0.8.0"

[lab.render]
big_int_as_hex = true
bytes_as_hex = false

[lab.config.default]
url = "http://127.0.0.1:6060"
env = "main"

[lab.scripts]
test-toggle = ["engines", "users", "logics"]

[scripts]
test-script = "coco compile .; pwd; uname -a"
