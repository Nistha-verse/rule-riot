.PHONY: test build typecheck discovery docker-build docker-run

test:
	npm test

build:
	npm run build

typecheck:
	npm run typecheck

discovery:
	npm run --silent discovery

docker-build:
	docker build -t rule-riot:local .

docker-run:
	docker run --rm -i rule-riot:local help
