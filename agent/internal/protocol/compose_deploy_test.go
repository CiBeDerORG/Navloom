package protocol

import (
	"encoding/json"
	"testing"
)

func deploymentPayload(id string) map[string]any {
	return map[string]any{
		"install_task_id": id,
		"manifest": map[string]any{
			"name": "navloom-nginx-abcdef123456",
			"services": map[string]any{
				"web": map[string]any{
					"image": "nginx:1.27.5-alpine",
					"restart": "unless-stopped",
					"ports": []string{"127.0.0.1:18080:80/tcp"},
				},
			},
		},
	}
}

func TestComposeDeployCommandRequiresExactTaskIDAndTrustedManifest(t *testing.T) {
	args := deploymentPayload(validTask)
	message, err := DecodeTaskDispatch(taskJSON(validAgent, "compose_deploy", args), validAgent)
	if err != nil || TaskOperation(message) != "compose_deploy" {
		t.Fatalf("trusted Compose command rejected: %v", err)
	}
	var manifest map[string]any
	if err := json.Unmarshal(TaskComposeManifest(message), &manifest); err != nil {
		t.Fatal(err)
	}
	if manifest["name"] != "navloom-nginx-abcdef123456" {
		t.Fatal("wrong manifest was extracted")
	}
	for _, mutation := range []func(map[string]any){
		func(x map[string]any) { x["install_task_id"] = "11111111-1111-4111-8111-111111111111" },
		func(x map[string]any) { x["shell"] = "id" },
		func(x map[string]any) { x["manifest"].(map[string]any)["privileged"] = true },
		func(x map[string]any) { x["manifest"].(map[string]any)["name"] = "../unsafe" },
		func(x map[string]any) { x["manifest"].(map[string]any)["services"].(map[string]any)["web"].(map[string]any)["command"] = "sh -c id" },
		func(x map[string]any) { x["manifest"].(map[string]any)["services"].(map[string]any)["web"].(map[string]any)["ports"] = []string{"0.0.0.0:18080:80/tcp"} },
		func(x map[string]any) { x["manifest"].(map[string]any)["services"].(map[string]any)["web"].(map[string]any)["volumes"] = []string{"/var/run/docker.sock:/var/run/docker.sock"} },
	} {
		item := deploymentPayload(validTask)
		mutation(item)
		if _, err := DecodeTaskDispatch(taskJSON(validAgent, "compose_deploy", item), validAgent); err == nil {
			t.Fatalf("malicious deployment accepted: %+v", item)
		}
	}
}
