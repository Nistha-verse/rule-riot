.PHONY: test api-test api build typecheck discovery docker-build docker-run

test:
	npm test

api-test:
	npm run api:test

api:
	npm run api

build:
	npm run build

typecheck:
	npm run typecheck

discovery:
	npm run --silent discovery

docker-build:
	docker build -t rule-riot:local .

docker-run:
	docker run --rm -i -p 3000:3000 rule-riot:local
