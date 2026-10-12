# One line of load-test metrics from Prometheus (port-forwarded on :9090), averaged over the given window.
import json, sys, urllib.parse, urllib.request
W = sys.argv[1] if len(sys.argv) > 1 else '1m'
def q(expr):
    url = 'http://localhost:9090/api/v1/query?' + urllib.parse.urlencode({'query': expr})
    r = json.load(urllib.request.urlopen(url))['data']['result']
    return float(r[0]['value'][1]) if r else float('nan')
m = {
    'node_cpu_%': 100 * (1 - q(f'avg(rate(node_cpu_seconds_total{{mode="idle"}}[{W}]))')),
    'tx_Mbps': q(f'rate(node_network_transmit_bytes_total{{device="enp2s0"}}[{W}])*8/1e6'),
    'rx_Mbps': q(f'rate(node_network_receive_bytes_total{{device="enp2s0"}}[{W}])*8/1e6'),
    'livekit_cores': q(f'sum(rate(container_cpu_usage_seconds_total{{namespace="zoom3d",pod=~"livekit.*",container!=""}}[{W}]))'),
    'server_cores': q(f'sum(rate(container_cpu_usage_seconds_total{{namespace="zoom3d",pod=~"zoom3d-server.*",container!=""}}[{W}]))'),
    'loop_p99_ms': 1000 * q('max(nodejs_eventloop_lag_p99_seconds{namespace="zoom3d"})'),
    'server_MiB': q('max(process_resident_memory_bytes{namespace="zoom3d",pod=~"zoom3d-server.*"})') / 2**20,
    'lk_MiB': q('max(container_memory_working_set_bytes{namespace="zoom3d",pod=~"livekit.*",container!=""})') / 2**20,
    'peers_msg/s': q(f'sum(rate(zoom3d_messages_sent_total{{type="peers"}}[{W}]))'),
    'peers_Mbps': q(f'sum(rate(zoom3d_bytes_sent_total{{type="peers"}}[{W}]))*8/1e6'),
    'state_in/s': q(f'sum(rate(zoom3d_messages_total{{type="state"}}[{W}]))'),
    'connected': q('max(zoom3d_peers{state="connected"})'),
}
print('  '.join(f'{k}={v:.2f}' for k, v in m.items()))
